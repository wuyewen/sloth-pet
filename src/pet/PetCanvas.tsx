import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { EMOTION_TO_EXPRESSION } from "../ai/emotion";
import { getSpeechLevel } from "../ai/voice";
import { getSettings, saveAvailableActions, saveMotionInfo, saveSettings } from "../store/settings";
import {
  VRM,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  VRMAnimation,
  VRMAnimationLoaderPlugin,
} from "@pixiv/three-vrm-animation";
import { IdleAnimator, ActionPlayer, ActionName, ClipPlayer, BehaviorEngine, EMOTION_ACTION, ACTION_DEFS } from "./animations";
import { buildClips } from "./clips";

/** 相机取景：框住几乎全身并留边距，人物在窗口中比例较小 */
function frameUpperBody(camera: THREE.PerspectiveCamera, vrm: VRM) {
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = box.getSize(new THREE.Vector3());

  const frameHeight = size.y * 1.08;
  const centerY = box.min.y + frameHeight / 2 - size.y * 0.02;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = frameHeight / (2 * Math.tan(fov / 2));

  const position = new THREE.Vector3(0, centerY, distance);
  const center = new THREE.Vector3(0, centerY, 0);
  camera.position.copy(position);
  camera.lookAt(center);
  return { position, center };
}

/** 灵动化参数：幅度/冷却/概率集中在此，方便微调手感 */
const LIVENESS = {
  /** 口型元音切换间隔（秒） */
  lipSwitchMin: 0.06,
  lipSwitchMax: 0.12,
  /** 扫视：注视目标偏移超过该距离（米）触发一次快速扫视 */
  saccadeThreshold: 0.15,
  /** 扫视逼近速率（越大到位越快） */
  saccadeSpeed: 14,
  /** 待机微表情间隔（秒） */
  microExprMin: 10,
  microExprMax: 20,
  /** 悬停多久（秒）引起角色注意 */
  hoverDelay: 0.6,
  /** 摸头：时间窗（秒）内光标累计位移（px）超过阈值触发 */
  petWindow: 2,
  petDistance: 350,
  petCooldown: 8,
  /** 戳一戳冷却（秒） */
  pokeCooldown: 3,
} as const;

/** VRMA 髋部平移是绝对坐标，按动画参考模型的髋高比例换算，
 *  与当前模型的比例/原点对不上时人物会整体沉底或漂移（只剩头顶）。
 *  改为相对首帧的增量、锚定到模型自身静止髋位：保留舞蹈起伏，消除整体漂移 */
function rebaseHipsTrack(clip: THREE.AnimationClip, vrm: VRM) {
  const hips = vrm.humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Hips);
  if (!hips) return;
  const rest = hips.position.clone();
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position")) continue; // VRMA 平移轨道只有髋部
    const v = track.values;
    if (v.length < 3) continue;
    const startX = v[0], startY = v[1], startZ = v[2];
    for (let i = 0; i < v.length; i += 3) {
      v[i] = rest.x + (v[i] - startX);
      v[i + 1] = rest.y + (v[i + 1] - startY);
      v[i + 2] = rest.z + (v[i + 2] - startZ);
    }
  }
}

export interface PetEmotion {
  tag: string;
  key: number;
}

export default function PetCanvas({
  modelUrl,
  emotion,
  busy,
  knocking,
  enabledActions,
  emotionActions,
  motionMeta,
}: {
  modelUrl: string;
  emotion?: PetEmotion | null;
  /** 对话/分析进行中：自主行为暂停，不打扰 */
  busy?: boolean;
  /** 提醒放大模式：期间每隔约 2.4s 重复敲屏 */
  knocking?: boolean;
  /** 启用的动作 id 列表（ACTION_DEFS） */
  enabledActions?: string[];
  /** 情绪 → 动作自定义映射（缺省回退内置 EMOTION_ACTION） */
  emotionActions?: Record<string, string>;
  /** 外部动作元数据（显示名、舞蹈标记），按文件名 stem 索引 */
  motionMeta?: Record<string, { name?: string; dance?: boolean }>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vrmRef = useRef<VRM | null>(null);
  const actionPlayerRef = useRef<ActionPlayer | null>(null);
  const clipPlayerRef = useRef<ClipPlayer | null>(null);
  const busyRef = useRef(false);
  const knockingRef = useRef(false);
  const enabledRef = useRef<Set<string>>(new Set());
  const emotionActionsRef = useRef<Record<string, string>>({});
  const motionMetaRef = useRef<Record<string, { name?: string; dance?: boolean }>>({});
  /** 按时长自动判定的舞蹈集合（>8s）：motionMeta 未显式标记时回退到此 */
  const autoDanceRef = useRef<Map<string, boolean>>(new Map());
  // 表情目标值：渲染循环每帧向其插值，避免表情瞬间跳变
  const exprTargetsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    busyRef.current = !!busy;
  }, [busy]);

  useEffect(() => {
    knockingRef.current = !!knocking;
  }, [knocking]);

  useEffect(() => {
    enabledRef.current = new Set(enabledActions ?? []);
  }, [enabledActions]);

  useEffect(() => {
    emotionActionsRef.current = emotionActions ?? {};
  }, [emotionActions]);

  // 舞蹈标记实时生效：设置页切换 dance 后无需重载模型
  useEffect(() => {
    const meta = motionMeta ?? {};
    motionMetaRef.current = meta;
    const cp = clipPlayerRef.current;
    if (!cp) return;
    for (const n of cp.names) {
      cp.setDance(n, meta[n]?.dance ?? autoDanceRef.current.get(n) ?? false);
    }
  }, [motionMeta]);

  // AI 回复的情绪标签 → VRM 表情 + 配套动作，5 秒后表情淡出回默认
  useEffect(() => {
    if (!emotion) return;
    const exprName = EMOTION_TO_EXPRESSION[emotion.tag];
    const targets = exprTargetsRef.current;
    for (const name of Object.values(EMOTION_TO_EXPRESSION)) {
      targets.set(name, 0);
    }
    if (exprName) targets.set(exprName, 1);
    const mapped =
      emotionActionsRef.current[emotion.tag] ?? EMOTION_ACTION[emotion.tag];
    if (mapped && enabledRef.current.has(mapped)) {
      if (mapped.startsWith("clip:")) clipPlayerRef.current?.play(mapped.slice(5));
      else actionPlayerRef.current?.play(mapped as ActionName);
    }
    if (!exprName) return;
    const timer = setTimeout(() => targets.set(exprName, 0), 5000);
    return () => clearTimeout(timer);
  }, [emotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    // 尺寸跟随容器（聊天打开时窗口右半是对话面板，画布只占左侧）；
    // updateStyle=false：保留 CSS 100%，否则内联像素样式会钉住画布不随容器缩放
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      30,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      20
    );

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.2));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(1, 2, 1.5);
    scene.add(dirLight);

    // 视线追踪目标（跟随窗口内光标）
    const lookTarget = new THREE.Object3D();
    scene.add(lookTarget);

    let vrm: VRM | null = null;
    let animator: IdleAnimator | null = null;
    let actionPlayer: ActionPlayer | null = null;
    let clipPlayer: ClipPlayer | null = null;
    let behavior: BehaviorEngine | null = null;
    let headY = 1.3;
    const camBase = new THREE.Vector3(0, 1.3, 1.6);
    const camCenter = new THREE.Vector3(0, 1.3, 0);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(modelUrl, async (gltf) => {
      const model = gltf.userData.vrm as VRM; // async 回调里用局部常量，避免 await 后丢失类型收窄
      vrm = model;
      vrmRef.current = model;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      scene.add(model.scene);

      // 骨骼动画会把顶点带离初始位置，但蒙皮网格的包围球停在绑定姿态，
      // 出画面就整个被剔除（表现为身体消失/闪烁）——动画模型必须关掉视锥剔除
      model.scene.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh || (o as THREE.Mesh).isMesh) {
          o.frustumCulled = false;
        }
      });

      // 朝向修正：VRM 0.x 模型正面朝 -Z（与 1.0 的 +Z 相反，加载后背对镜头），
      // rotateVRM0 内部自检 metaVersion === "0" 自动转正，1.0 模型不受影响
      VRMUtils.rotateVRM0(model);

      // 尺寸归一化：动作幅度参数按头高 ~1.3m 调校，把模型缩放到该基准，
      // 否则过大/过小的模型做蹦跳、空翻时会飞出取景范围
      {
        const hb = model.humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Head);
        if (hb) {
          const p = new THREE.Vector3();
          hb.getWorldPosition(p);
          if (p.y > 0.01) {
            const s = 1.3 / p.y;
            if (Math.abs(1 - s) > 0.05) {
              model.scene.scale.setScalar(s);
              model.scene.updateMatrixWorld(true);
            }
          }
        }
      }

      const head = model.humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Head);
      if (head) {
        const p = new THREE.Vector3();
        head.getWorldPosition(p);
        headY = p.y;
      }
      lookTarget.position.set(0, headY, 1);
      cursorPos.set(0, headY, 1);
      gazePos.set(0, headY, 1);
      saccadeTarget.set(0, headY, 1);
      if (model.lookAt) model.lookAt.target = lookTarget;

      // 口型同步可用元音：按模型实际注册的表情过滤（VRM 1.0 预设 aa/ih/ou）
      vowels.push(
        ...["aa", "ih", "ou"].filter((v) =>
          model.expressionManager?.getExpression(v)
        )
      );

      // 垂手修正：把手臂转到"自然下垂微张"（水平线下约 50°）。
      // 按世界空间方向计算——硬编码角度会踩模型骨骼轴向约定的坑
      // （轴向相反时同角度旋转方向也相反，手臂会被抬起来）
      const dropArm = (upper: VRMHumanBoneName, lower: VRMHumanBoneName) => {
        const u = model.humanoid?.getNormalizedBoneNode(upper);
        const l = model.humanoid?.getNormalizedBoneNode(lower);
        if (!u || !l || !u.parent) return;
        model.scene.updateMatrixWorld(true);
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        u.getWorldPosition(a);
        l.getWorldPosition(b);
        const dir = b.sub(a).normalize();
        if (dir.y < -0.55) return; // 已经下垂（A/I-pose 自然位）则不修正
        const side = dir.x >= 0 ? 1 : -1;
        const target = new THREE.Vector3(side * 0.64, -0.77, 0).normalize();
        const delta = new THREE.Quaternion().setFromUnitVectors(dir, target);
        const parentQ = (u.parent as THREE.Object3D).getWorldQuaternion(
          new THREE.Quaternion()
        );
        const worldQ = u.getWorldQuaternion(new THREE.Quaternion());
        u.quaternion.copy(parentQ.invert().multiply(delta).multiply(worldQ));
        model.scene.updateMatrixWorld(true);
      };
      dropArm(VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.LeftLowerArm);
      dropArm(VRMHumanBoneName.RightUpperArm, VRMHumanBoneName.RightLowerArm);

      // 探测骨骼轴向约定：微转骨骼，看子骨骼世界位移是否朝镜头（+Z）。
      // 轴向反的模型上硬编码动作方向会整个做反。
      // （手臂动作已改为世界空间方向瞄准，无需探测；脊柱前倾幅度小、位移信号可靠，保留探测）
      const probeSign = (
        bone: VRMHumanBoneName,
        child: VRMHumanBoneName,
        axis: "x" | "z",
        delta: number
      ): number => {
        const b = model.humanoid?.getNormalizedBoneNode(bone);
        const c = model.humanoid?.getNormalizedBoneNode(child);
        if (!b || !c) return 1;
        model.scene.updateMatrixWorld(true);
        const beforeZ = c.getWorldPosition(new THREE.Vector3()).z;
        const rest = b.rotation[axis];
        b.rotation[axis] = rest + delta;
        model.scene.updateMatrixWorld(true);
        const afterZ = c.getWorldPosition(new THREE.Vector3()).z;
        b.rotation[axis] = rest;
        model.scene.updateMatrixWorld(true);
        return afterZ >= beforeZ ? 1 : -1;
      };
      // 脊柱：打瞌睡用 +x 前倾，期望头部向镜头（+Z）移动
      const spineSign = probeSign(
        VRMHumanBoneName.Spine,
        VRMHumanBoneName.Head,
        "x",
        0.1
      );
      // 颈骨单独探测：VRM0 归一化骨骼相对 VRM1 绕 Y 镜像，颈骨轴向符号
      // 与脊柱未必一致，复用会让点头/栽头在部分模型上反向（看起来幅度夸张）
      const neckSign = probeSign(
        VRMHumanBoneName.Neck,
        VRMHumanBoneName.Head,
        "x",
        0.1
      );

      // 动作片段 = 内置手工片段 + 外部 VRMA 文件（模型目录 motions/*.vrma，文件名即动作名）。
      // 长短分流：时长 >8s 自动归为舞蹈（完整播放、不进随机池），可在设置页用 motionMeta 覆盖
      const clipMap = new Map<string, { clip: THREE.AnimationClip; dance: boolean }>();
      for (const [n, c] of buildClips(model)) clipMap.set(n, { clip: c, dance: false });
      try {
        // 资产目录可自定义（设置页），此处重新读一次设置拿当前目录
        const s = await getSettings().catch((e) => {
          console.warn("读取设置失败，动作扫描回退默认目录:", e);
          return null;
        });
        const motionPaths = await invoke<string[]>("list_motions", {
          dir: s?.modelDir || null,
        });
        if (s?.modelDir) {
          console.log(`扫描自定义资产目录 ${s.modelDir}，找到 ${motionPaths.length} 个动作`);
        }
        if (motionPaths.length > 0) {
          const vrmaLoader = new GLTFLoader();
          vrmaLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
          for (const path of motionPaths) {
            try {
              const g = await vrmaLoader.loadAsync(convertFileSrc(path));
              const anim = (g.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0];
              if (!anim) continue;
              const stem = path.split("/").pop()!.replace(/\.vrma$/i, "");
              const clip = createVRMAnimationClip(anim, model);
              rebaseHipsTrack(clip, model);
              const auto = clip.duration > 8;
              autoDanceRef.current.set(stem, auto);
              clipMap.set(stem, {
                clip,
                dance: motionMetaRef.current[stem]?.dance ?? auto,
              });
            } catch (e) {
              console.error("VRMA 动作加载失败", path, e);
            }
          }
        }
      } catch (e) {
        console.error("动作文件扫描失败", e);
      }

      const framed = frameUpperBody(camera, model);
      camBase.copy(framed.position);
      camCenter.copy(framed.center);
      animator = new IdleAnimator(model);
      actionPlayer = new ActionPlayer(model, { spineSign, neckSign });
      actionPlayerRef.current = actionPlayer;
      clipPlayer = new ClipPlayer(model, clipMap);
      clipPlayerRef.current = clipPlayer;
      behavior = new BehaviorEngine(actionPlayer, model, clipPlayer, () => enabledRef.current);

      // 动作注册：探测该模型实际支持的动作（骨骼/表情/片段），写入设置存储供动作开关列表使用
      const hasBone = (n: VRMHumanBoneName) =>
        !!model.humanoid?.getNormalizedBoneNode(n);
      const available: string[] = [];
      if (hasBone(VRMHumanBoneName.RightUpperArm) && hasBone(VRMHumanBoneName.RightLowerArm)) {
        available.push("wave", "knock");
      }
      if (hasBone(VRMHumanBoneName.Hips)) available.push("bounce");
      available.push("nod", "shake", "doze"); // 头部动作走 lookAt，模型必有头骨
      for (const n of clipPlayer.names) available.push(`clip:${n}`);
      if (model.expressionManager?.getExpression("aa")) available.push("yawn");
      await saveAvailableActions(available);
      // 片段时长落库：设置页展示时长、辅助判断长短动作
      await saveMotionInfo(
        [...clipMap.entries()].map(([n, e]) => ({
          id: `clip:${n}`,
          duration: Math.round(e.clip.duration * 10) / 10,
        }))
      );
      // 新放入的外部动作文件默认启用，避免"文件放了却没反应"；内置动作维持用户既有选择
      const builtin = new Set(ACTION_DEFS.map((a) => a.id));
      const external = available.filter(
        (id) => id.startsWith("clip:") && !builtin.has(id)
      );
      if (external.length > 0) {
        const s = await getSettings();
        const missing = external.filter((id) => !s.enabledActions.includes(id));
        if (missing.length > 0) {
          await saveSettings({ ...s, enabledActions: [...s.enabledActions, ...missing] });
          emit("settings-changed");
        }
      }
      emit("actions-synced");
    });

    // 单击戳一戳：延迟 260ms 确认不是双击 → 惊讶表情 + 点头（有冷却，对话中不响应）
    let pokeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPokeAt = 0;
    const onClick = () => {
      if (busyRef.current) return;
      if (pokeTimer) clearTimeout(pokeTimer);
      pokeTimer = setTimeout(() => {
        pokeTimer = null;
        const now = performance.now() / 1000;
        if (now - lastPokeAt < LIVENESS.pokeCooldown) return;
        lastPokeAt = now;
        flashExpression("surprised", 0.7, 1.5);
        if (
          enabledRef.current.has("nod") &&
          actionPlayer &&
          !actionPlayer.playing
        ) {
          actionPlayer.play("nod");
        }
      }, 260);
    };
    canvas.addEventListener("click", onClick);

    // 双击角色 → 从启用的动作/片段中随机来一个（舞蹈类长片段不参与随机）
    const onDblClick = () => {
      // 双击取消待触发的戳一戳
      if (pokeTimer) {
        clearTimeout(pokeTimer);
        pokeTimer = null;
      }
      const en = enabledRef.current;
      const clips = clipPlayer?.shortNames.filter((n) => en.has(`clip:${n}`)) ?? [];
      const acts = (["wave", "nod", "shake", "bounce", "doze", "knock"] as ActionName[])
        .filter((a) => en.has(a));
      const total = clips.length + acts.length;
      if (total === 0) return;
      if (Math.random() < clips.length / total) {
        clipPlayer?.play(clips[Math.floor(Math.random() * clips.length)]);
      } else {
        actionPlayer?.play(acts[Math.floor(Math.random() * acts.length)]);
      }
    };
    canvas.addEventListener("dblclick", onDblClick);

    // 全局光标位置由 Rust 轮询广播（窗口穿透时 DOM 收不到 pointermove）。
    // cursorPos 是注视目标的"意图位置"，扫视逻辑在渲染循环里。
    const cursorNdc = new THREE.Vector3();
    const cursorPos = new THREE.Vector3(0, 1.3, 1);
    // 视线漫游：光标 6 秒不动时，注视点在环境中游走
    let lastCursorAt = 0;
    const gazePos = new THREE.Vector3(0, 1.3, 1);
    // 扫视目标：视线以快速扫视逼近它，到位后凝视（而非匀速平滑跟随）
    const saccadeTarget = new THREE.Vector3(0, 1.3, 1);
    const gazeDesired = new THREE.Vector3();
    const wanderTarget = new THREE.Vector3(0, 1.3, 1);
    let wanderNextAt = 0;
    // 悬停注意/摸头检测状态
    const hover = { inside: false, since: 0, nx: 0 };
    const petting = { accum: 0, windowStart: 0, lastX: 0, lastY: 0, lastReactAt: 0 };
    // 口型同步状态
    const lip = { vowel: "aa", nextSwitchAt: 0, peak: 0.6 };
    let talkingActive = false;
    let thinkingActive = false;
    let nextMicroAt = 12; // 启动 12s 后才开始微表情，避免刚打开就"戏太多"
    /** 模型实际支持的口型表情（模型加载后填充） */
    const vowels: string[] = [];

    /** 短时表情：写入目标值，holdSec 后归零（渲染循环负责插值淡出） */
    const flashExpression = (name: string, weight: number, holdSec: number) => {
      if (!vrm?.expressionManager?.getExpression(name)) return;
      const targets = exprTargetsRef.current;
      targets.set(name, weight);
      setTimeout(() => {
        if (targets.get(name) === weight) targets.set(name, 0);
      }, holdSec * 1000);
    };

    const updateLookTarget = (x: number, y: number) => {
      lastCursorAt = performance.now() / 1000;
      const nx = (x / canvas.clientWidth) * 2 - 1;
      const ny = -(y / canvas.clientHeight) * 2 + 1;

      // 悬停注意：光标进入画布区域（宠物所在），停留后角色会看向并倾向光标
      const now = performance.now() / 1000;
      const inside =
        x >= 0 && x <= canvas.clientWidth && y >= 0 && y <= canvas.clientHeight;
      if (inside) {
        if (!hover.inside) hover.since = now;
        hover.inside = true;
        hover.nx = nx;
        // 摸头：光标在头部区域（画面上半、中间）来回移动，累计位移超阈值触发
        const nearHead = ny > 0.15 && Math.abs(nx) < 0.7;
        if (nearHead && !busyRef.current) {
          if (now - petting.windowStart > LIVENESS.petWindow) {
            petting.windowStart = now;
            petting.accum = 0;
          }
          petting.accum += Math.hypot(x - petting.lastX, y - petting.lastY);
          if (
            petting.accum > LIVENESS.petDistance &&
            now - petting.lastReactAt > LIVENESS.petCooldown
          ) {
            petting.lastReactAt = now;
            petting.accum = 0;
            flashExpression("happy", 0.6, 2.5);
            if (
              enabledRef.current.has("bounce") &&
              actionPlayer &&
              !actionPlayer.playing
            ) {
              actionPlayer.play("bounce");
            }
          }
        }
      } else {
        hover.inside = false;
      }
      petting.lastX = x;
      petting.lastY = y;

      cursorNdc.set(nx, ny, 0.5);
      cursorNdc.unproject(camera);
      const dir = cursorNdc.sub(camera.position).normalize();
      const planeZ = camera.position.z * 0.4; // 角色与相机之间的平面
      const dist = (planeZ - camera.position.z) / dir.z;
      cursorPos
        .copy(camera.position)
        .add(dir.multiplyScalar(Math.max(dist, 0.1)));

      // 视差：相机随光标轻微移动，制造"透过窗口看立体角色"的纵深错觉
      camera.position.set(
        camBase.x + nx * 0.05,
        camBase.y + ny * 0.03,
        camBase.z
      );
      camera.lookAt(camCenter);
    };

    let cancelled = false;
    let unlistenCursor: (() => void) | null = null;
    listen<[number, number]>("cursor-move", (e) => {
      updateLookTarget(e.payload[0], e.payload[1]);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenCursor = fn;
    });

    // 设置页「试播」按钮 → 立即演示动作（无需保存；舞蹈片段完整播放）
    let unlistenPreview: (() => void) | null = null;
    listen<{ id: string }>("preview-action", (e) => {
      const id = e.payload.id;
      if (id.startsWith("clip:")) clipPlayer?.play(id.slice(5));
      else if (id === "yawn") behavior?.yawn();
      else actionPlayer?.play(id as ActionName);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenPreview = fn;
    });

    const clock = new THREE.Clock();
    let lastKnockAt = -10; // 启动即允许立刻敲第一次
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.1);
      const now = performance.now() / 1000;

      // TTS 播报音量 → 说话身体语言（口型在下方表情之后写入）
      const speechLevel = getSpeechLevel();
      animator?.setTalking(speechLevel);
      // 悬停注意：光标停留片刻后，身体向光标方向微倾
      animator?.setLean(
        hover.inside && now - hover.since > LIVENESS.hoverDelay
          ? hover.nx * 0.8
          : 0
      );

      animator?.update(dt);
      actionPlayer?.update(dt);
      clipPlayer?.update(dt);
      behavior?.update(dt, busyRef.current);
      // 提醒放大模式：固定间隔持续敲屏，直到恢复
      if (
        knockingRef.current &&
        enabledRef.current.has("knock") &&
        actionPlayer &&
        !actionPlayer.playing &&
        now - lastKnockAt > 2.4
      ) {
        actionPlayer.play("knock");
        lastKnockAt = now;
      }

      // 注视目标：光标活跃时跟光标；闲置时漫游到随机点（东张西望）。
      // 扫视模型：目标偏移超阈值才触发快速扫视，到位后凝视镜微颤——眼神不再匀速漂移
      const cursorActive = now - lastCursorAt < 6;
      if (!cursorActive && now > wanderNextAt) {
        wanderTarget.set(
          (Math.random() - 0.5) * 1.6,
          headY + (Math.random() - 0.5) * 0.7,
          1
        );
        wanderNextAt = now + 1.5 + Math.random() * 2.5;
      }
      gazeDesired.copy(cursorActive ? cursorPos : wanderTarget);
      if (busyRef.current) gazeDesired.y += 0.3; // 思考时视线上移
      if (gazeDesired.distanceTo(saccadeTarget) > LIVENESS.saccadeThreshold) {
        saccadeTarget.copy(gazeDesired);
      }
      gazePos.lerp(saccadeTarget, Math.min(1, dt * LIVENESS.saccadeSpeed));
      lookTarget.position.copy(gazePos);
      lookTarget.position.x += Math.sin(now * 1.3) * 0.005;
      lookTarget.position.y += Math.sin(now * 1.7 + 2) * 0.005;

      // 思考状态：AI 生成中且无其他情绪时，轻微疑惑表情
      const targets = exprTargetsRef.current;
      const emotionActive = Object.values(EMOTION_TO_EXPRESSION).some(
        (n) => (targets.get(n) ?? 0) > 0
      );
      if (busyRef.current && !emotionActive) {
        targets.set("surprised", 0.25);
        thinkingActive = true;
      } else if (thinkingActive) {
        if (targets.get("surprised") === 0.25) targets.set("surprised", 0);
        thinkingActive = false;
      }

      // 待机微表情：无情绪、非对话中，每 10~20s 来一次 2~3s 的浅表情（慵懒人设以放松为主）
      if (!emotionActive && !busyRef.current && now > nextMicroAt) {
        const name = Math.random() < 0.7 ? "relaxed" : "happy";
        flashExpression(name, 0.1 + Math.random() * 0.15, 2 + Math.random());
        nextMicroAt =
          now +
          LIVENESS.microExprMin +
          Math.random() * (LIVENESS.microExprMax - LIVENESS.microExprMin);
      }

      // 表情向目标值插值：淡入快、淡出慢
      const mgr = vrm?.expressionManager;
      if (mgr) {
        for (const [name, target] of targets) {
          const cur = mgr.getValue(name) ?? 0;
          const speed = target > cur ? 10 : 3;
          const next = cur + (target - cur) * Math.min(1, dt * speed);
          if (target === 0 && next < 0.01) {
            mgr.setValue(name, 0);
            targets.delete(name);
          } else {
            mgr.setValue(name, next);
          }
        }
      }

      // 口型同步：在表情插值之后写入，说话优先于哈欠等占用嘴部的表现；
      // 按音量驱动、元音随机切换（aa 50%，其余均分），比单一 aa 开合自然
      if (mgr && vowels.length > 0) {
        if (speechLevel > 0.02) {
          talkingActive = true;
          if (now > lip.nextSwitchAt) {
            lip.nextSwitchAt =
              now +
              LIVENESS.lipSwitchMin +
              Math.random() * (LIVENESS.lipSwitchMax - LIVENESS.lipSwitchMin);
            lip.vowel =
              Math.random() < 0.5 && vowels.includes("aa")
                ? "aa"
                : vowels[Math.floor(Math.random() * vowels.length)];
            lip.peak = 0.4 + Math.random() * 0.6;
          }
          for (const v of vowels) {
            const target = v === lip.vowel ? speechLevel * lip.peak : 0;
            const cur = mgr.getValue(v) ?? 0;
            const speed = target > cur ? 25 : 10;
            mgr.setValue(v, cur + (target - cur) * Math.min(1, dt * speed));
          }
        } else if (talkingActive) {
          // 播报结束：收嘴
          let allClosed = true;
          for (const v of vowels) {
            const cur = mgr.getValue(v) ?? 0;
            const next = cur * Math.max(0, 1 - dt * 10);
            mgr.setValue(v, next < 0.02 ? 0 : next);
            if (next >= 0.02) allClosed = false;
          }
          if (allClosed) talkingActive = false;
        }
      }

      vrm?.update(dt);
      renderer.render(scene, camera);
    });

    const onResize = () => {
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvas);

    return () => {
      cancelled = true;
      unlistenCursor?.();
      unlistenPreview?.();
      canvas.removeEventListener("dblclick", onDblClick);
      canvas.removeEventListener("click", onClick);
      if (pokeTimer) clearTimeout(pokeTimer);
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      actionPlayerRef.current = null;
      clipPlayerRef.current = null;
      autoDanceRef.current.clear();
      if (vrm) {
        VRMUtils.deepDispose(vrm.scene);
        scene.remove(vrm.scene);
        vrmRef.current = null;
      }
      renderer.dispose();
    };
  }, [modelUrl]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
