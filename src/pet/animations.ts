import * as THREE from "three";
import { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";

export type ActionName = "wave" | "nod" | "shake" | "bounce" | "doze" | "knock";

const ACTION_DURATION: Record<ActionName, number> = {
  wave: 1.8,
  nod: 1.0,
  shake: 1.1,
  bounce: 1.1,
  doze: 3.0, // 全部动作上限 3 秒
  knock: 1.6,
};

/** 情绪标签 → 配套动作（配合面部表情） */
export const EMOTION_ACTION: Record<string, ActionName> = {
  happy: "bounce",
  surprised: "nod",
  sad: "shake",
  angry: "shake",
};

/** 全部可配置动作（设置页开关；id 为动作名，clip: 前缀为手工片段，yawn 为打哈欠） */
export const ACTION_DEFS: { id: string; name: string }[] = [
  { id: "wave", name: "挥手" },
  { id: "nod", name: "点头" },
  { id: "shake", name: "摇头" },
  { id: "bounce", name: "蹦跳" },
  { id: "doze", name: "打瞌睡栽头" },
  { id: "knock", name: "敲屏幕" },
  { id: "clip:stretch", name: "伸懒腰（片段）" },
  { id: "clip:excited", name: "兴奋摇摆（片段）" },
  { id: "clip:scratch", name: "思考挠头（片段）" },
  { id: "yawn", name: "打哈欠" },
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 平滑起停（smoothstep） */
const easeInOut = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

/** 过冲回弹：快速到位后轻微弹回，制造"活"的感觉 */
const easeOutBack = (x: number) => {
  const c = 1.70158;
  const u = clamp01(x) - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

/** 打瞌睡栽头曲线：缓缓前栽 → 栽住片刻 → 惊醒抬头（先快后慢，不回仰过冲） */
function dozeAmount(p: number): number {
  if (p < 0.45) return easeInOut(p / 0.45); // 缓缓栽下去
  if (p < 0.6) return 1; // 栽住停留
  return Math.pow(1 - (p - 0.6) / 0.4, 3); // 惊醒：快速抬起，渐慢归位
}

/** 骨骼方向瞄准所需的静止姿态快照（世界空间方向 + 各层四元数） */
interface BoneAim {
  restLocal: THREE.Quaternion;
  restWorld: THREE.Quaternion;
  parentWorldInv: THREE.Quaternion;
  restDir: THREE.Vector3;
  /** 手臂外展方向（模型自身左/右），由静止姿态实测，不假设坐标约定 */
  side: number;
}

const _aimDelta = new THREE.Quaternion();
const _aimPartial = new THREE.Quaternion();
const _aimGoal = new THREE.Vector3();

/**
 * 程序化动作播放器。
 * 所有动作带淡入淡出权重，避免起止瞬间骨骼跳变；
 * 关节错峰 + 预备/跟随动作（下蹲蓄力、落地压缩）避免机械感。
 * 手臂动作（挥手/敲屏）用「世界空间目标方向」摆骨骼（与 dropArm 同款做法），
 * 不依赖模型骨骼局部轴向约定——按局部轴写死角度在轴向不同的模型上会反向（背手）。
 * 点头/摇头/栽头直接转颈骨：归一化骨骼局部轴对齐世界轴，lookAt 只控头骨不控颈骨，无冲突。
 */
export class ActionPlayer {
  private t = -1;
  private name: ActionName | null = null;
  private bones: Record<string, THREE.Object3D | null>;
  private scene: THREE.Object3D;
  /** 场景基准缩放（PetCanvas 尺寸归一化的结果）：squash 在此基础上叠加，不能覆盖 */
  private baseScale = new THREE.Vector3(1, 1, 1);
  /** 脊柱前倾方向符号：不同模型骨骼轴向约定不同，由 PetCanvas 实测探测 */
  private spineSign: number;
  /** 颈部前俯方向符号：VRM0 归一化骨骼相对 VRM1 镜像，颈骨符号与脊柱可能相反，单独探测 */
  private neckSign: number;
  /** 大臂/前臂的方向瞄准快照（构造时捕捉，含垂手修正后的静止姿态） */
  private armAim: BoneAim | null = null;
  private foreAim: BoneAim | null = null;

  constructor(vrm: VRM, opts?: { spineSign?: number; neckSign?: number }) {
    this.spineSign = opts?.spineSign ?? 1;
    this.neckSign = opts?.neckSign ?? this.spineSign;
    const get = (n: VRMHumanBoneName) =>
      vrm.humanoid?.getNormalizedBoneNode(n) ?? null;
    this.bones = {
      hips: get(VRMHumanBoneName.Hips),
      spine: get(VRMHumanBoneName.Spine),
      neck: get(VRMHumanBoneName.Neck),
      rArm: get(VRMHumanBoneName.RightUpperArm),
      rFore: get(VRMHumanBoneName.RightLowerArm),
    };
    this.scene = vrm.scene;
    this.baseScale.copy(vrm.scene.scale);

    // 捕捉手臂静止姿态（世界空间），供挥手/敲屏做方向瞄准
    const u = this.bones.rArm;
    const l = this.bones.rFore;
    const hand = get(VRMHumanBoneName.RightHand);
    if (u && l && u.parent) {
      this.scene.updateMatrixWorld(true);
      const up = u.getWorldPosition(new THREE.Vector3());
      const lp = l.getWorldPosition(new THREE.Vector3());
      const dir = lp.clone().sub(up).normalize();
      this.armAim = {
        restLocal: u.quaternion.clone(),
        restWorld: u.getWorldQuaternion(new THREE.Quaternion()),
        parentWorldInv: (u.parent as THREE.Object3D)
          .getWorldQuaternion(new THREE.Quaternion())
          .invert(),
        restDir: dir,
        side: dir.x >= 0 ? 1 : -1,
      };
      if (hand) {
        const hp = hand.getWorldPosition(new THREE.Vector3());
        this.foreAim = {
          restLocal: l.quaternion.clone(),
          restWorld: l.getWorldQuaternion(new THREE.Quaternion()),
          parentWorldInv: u
            .getWorldQuaternion(new THREE.Quaternion())
            .invert(),
          restDir: hp.sub(lp).normalize(),
          side: dir.x >= 0 ? 1 : -1,
        };
      }
    }
  }

  get playing(): boolean {
    return this.t >= 0;
  }

  play(name: ActionName) {
    this.name = name;
    this.t = 0;
  }

  /** 动作整体权重：开头 12% 淡入、结尾 22% 淡出 */
  private blend(p: number): number {
    return easeInOut(p / 0.12) * easeInOut((1 - p) / 0.22);
  }

  /** 把骨骼从静止方向摆向世界空间目标方向（weight 0..1 插值），轴向约定无关 */
  private aimBone(
    bone: THREE.Object3D,
    aim: BoneAim,
    goalDir: THREE.Vector3,
    weight: number
  ) {
    _aimDelta.setFromUnitVectors(aim.restDir, goalDir);
    _aimPartial.identity().slerp(_aimDelta, weight);
    bone.quaternion
      .copy(aim.parentWorldInv)
      .multiply(_aimPartial)
      .multiply(aim.restWorld);
  }

  /** 施加整体压缩/拉伸（squash & stretch），stretch>0 拉长，<0 压扁。
   *  在基准缩放（尺寸归一化）之上叠加，避免把归一化缩放冲掉 */
  private applySquash(stretch: number) {
    this.scene.scale.set(
      this.baseScale.x * (1 - stretch * 0.5),
      this.baseScale.y * (1 + stretch),
      this.baseScale.z * (1 - stretch * 0.5)
    );
  }

  update(dt: number) {
    if (this.t < 0 || !this.name) return;
    this.t += dt;
    const dur = ACTION_DURATION[this.name];
    const p = Math.min(this.t / dur, 1); // 0..1
    const w = this.blend(p);

    const { hips, spine, neck, rArm, rFore } = this.bones;
    switch (this.name) {
      case "wave": {
        // 抬臂快速到位（过冲只作用于节奏，权重 clamp 到 1——空间上绝不超过目标）；
        // 放下用平滑缓动；前臂摆动渐入渐出；身体侧倾配合。
        // 目标方向为世界空间：向镜头方向（+Z）抬起、略向外——手始终在身体前方，
        // 大头 Q 版模型上也不会被头部遮挡（向上举会陷进头部轮廓，看起来像"到头后"）
        const up = easeOutBack(p / 0.28);
        const down = easeInOut((p - 0.78) / 0.22);
        const lift = clamp01(Math.max(0, up - down));
        const swingAmt = clamp01((p - 0.2) / 0.12) * (1 - down);
        const swing = Math.sin(this.t * 11) * swingAmt;
        if (rArm && this.armAim) {
          _aimGoal.set(this.armAim.side * 0.45, 0.35, 0.8).normalize();
          this.aimBone(rArm, this.armAim, _aimGoal, lift);
        }
        if (rFore && this.foreAim) {
          // 前臂向前上方展开，随摆动左右摇
          _aimGoal
            .set(this.foreAim.side * (0.25 + swing * 0.3), 0.75, 0.55)
            .normalize();
          this.aimBone(rFore, this.foreAim, _aimGoal, lift);
        }
        if (hips) hips.rotation.z += lift * 0.06 * (this.armAim?.side ?? 1);
        if (spine) spine.rotation.z += lift * 0.05 + swing * 0.04;
        break;
      }
      case "bounce": {
        // 开心蹦两下：上升时拉长、落地瞬间压扁
        const hop = Math.abs(Math.sin(p * Math.PI * 2)) * 0.1 * w;
        if (hips) hips.position.y += hop;
        if (spine) spine.rotation.x -= hop * 0.6;
        this.applySquash(Math.sin(p * Math.PI * 4) * 0.06 * w);
        break;
      }
      case "knock": {
        // 敲击屏幕吸引注意：手臂伸向镜头（玻璃在 +Z，相机一侧）→ 前臂快速叩击两次 → 收臂；
        // 叩击瞬间整体向镜头前顶，模拟敲在玻璃上的冲击感
        const up = easeOutBack(p / 0.22);
        const down = easeInOut((p - 0.82) / 0.18);
        const lift = Math.max(0, up - down);
        const tap = (center: number) =>
          Math.max(0, 1 - Math.abs(p - center) / 0.06);
        const tapAmt = (tap(0.38) + tap(0.6)) * lift;
        if (rArm && this.armAim) {
          _aimGoal.set(this.armAim.side * 0.15, 0.45, 1).normalize();
          this.aimBone(rArm, this.armAim, _aimGoal, lift * 0.9);
        }
        if (rFore && this.foreAim) {
          // 前臂指向玻璃，叩击瞬间再向前送一点
          _aimGoal
            .set(this.foreAim.side * 0.05, 0.1 + tapAmt * 0.15, 1)
            .normalize();
          this.aimBone(rFore, this.foreAim, _aimGoal, Math.min(1, lift + tapAmt * 0.4));
        }
        // 叩击瞬间整体向镜头前顶（绝对赋值：+= 会逐帧累加成前扑，结束时又瞬移回去）
        this.scene.position.z = tapAmt * 0.06;
        this.applySquash(tapAmt * 0.04);
        if (hips) hips.rotation.z += lift * 0.05 * (this.armAim?.side ?? 1);
        break;
      }
      case "doze": {
        // 打瞌睡：身体随栽头缓缓前倾，颈部低垂（栽头本体）
        const amt = dozeAmount(p) * w;
        if (spine) spine.rotation.x += amt * 0.15 * this.spineSign;
        if (neck) neck.rotation.x += amt * 0.4 * this.neckSign;
        break;
      }
      case "nod": {
        // 点头：颈部前俯一次（单段下去-回来），幅度收敛在小幅点头范围。
        // 方向符号用颈骨实测值（VRM0 归一化骨骼相对 VRM1 镜像，与脊柱符号可能相反）
        const amt = Math.sin(p * Math.PI) * 0.15 * w;
        if (neck) neck.rotation.x += amt * this.neckSign;
        break;
      }
      case "shake": {
        // 摇头：颈部左右摆动两个来回（振荡对称，无需方向符号）
        const amt = Math.sin(p * Math.PI * 4) * 0.22 * w * (1 - p * 0.3);
        if (neck) neck.rotation.y += amt;
        break;
      }
    }

    if (p >= 1) {
      this.t = -1;
      this.name = null;
      // 复原骨骼到静止位姿
      if (rArm && this.armAim) rArm.quaternion.copy(this.armAim.restLocal);
      if (rFore && this.foreAim) rFore.quaternion.copy(this.foreAim.restLocal);
      this.scene.position.set(0, 0, 0);
      this.scene.scale.copy(this.baseScale);
    }
  }
}

/** 程序化待机动画：非对称呼吸 + 重心转移 + 手臂跟随摆动 + 头部微倾 + 随机眨眼；
 *  支持外部注入「倾身」（悬停互动）与「说话强度」（播报时的身体语言） */
export class IdleAnimator {
  private elapsed = 0;
  private nextBlinkAt = 2;
  private blinkPhase: number | null = null;
  private hipsRestY = 0;
  private spineRestX = 0;
  private lArmRestZ = 0;
  private rArmRestZ = 0;
  private hips: THREE.Object3D | null = null;
  private spine: THREE.Object3D | null = null;
  private lArm: THREE.Object3D | null = null;
  private rArm: THREE.Object3D | null = null;
  private neck: THREE.Object3D | null = null;
  private neckRest = { x: 0, y: 0, z: 0 };
  private neckTarget = { x: 0, y: 0, z: 0 };
  /** 颈部微倾的缓动状态（内部维护，绝对不写回读取骨骼当前值，见 update 注释） */
  private neckCur = { x: 0, y: 0, z: 0 };
  private nextTiltAt = 3;
  /** 倾身目标/当前值（-1..1，光标方向），悬停互动注入 */
  private lean = 0;
  private leanCur = 0;
  /** 说话强度目标/当前值（0..1），TTS 播报时注入 */
  private talkLevel = 0;
  private talkCur = 0;
  private nodPhase = -1;
  private nextNodAt = 0;

  constructor(private vrm: VRM) {
    const get = (n: VRMHumanBoneName) =>
      vrm.humanoid?.getNormalizedBoneNode(n) ?? null;
    this.hips = get(VRMHumanBoneName.Hips);
    this.spine = get(VRMHumanBoneName.Spine);
    this.lArm = get(VRMHumanBoneName.LeftUpperArm);
    this.rArm = get(VRMHumanBoneName.RightUpperArm);
    this.neck = get(VRMHumanBoneName.Neck);
    if (this.hips) this.hipsRestY = this.hips.position.y;
    if (this.spine) this.spineRestX = this.spine.rotation.x;
    if (this.lArm) this.lArmRestZ = this.lArm.rotation.z;
    if (this.rArm) this.rArmRestZ = this.rArm.rotation.z;
    if (this.neck) {
      this.neckRest = {
        x: this.neck.rotation.x,
        y: this.neck.rotation.y,
        z: this.neck.rotation.z,
      };
    }
  }

  /** 倾身（悬停互动）：-1 左倾 ~ 1 右倾 */
  setLean(v: number) {
    this.lean = Math.max(-1, Math.min(1, v));
  }

  /** 说话强度（口型同步音量），播报时身体随声音轻微起伏 */
  setTalking(level: number) {
    this.talkLevel = Math.max(0, Math.min(1, level));
  }

  update(dt: number) {
    this.elapsed += dt;
    const t = this.elapsed;

    // 呼吸：吸气快、呼气慢的非对称曲线（约 3.5s 一循环）
    const breathT = (t * 0.28) % 1;
    const breath =
      breathT < 0.4
        ? easeInOut(breathT / 0.4)
        : 1 - easeInOut((breathT - 0.4) / 0.6);
    // 缓慢的重心左右转移
    const shift = Math.sin(t * 0.35 + 1.3);

    // 倾身/说话强度向目标平滑靠近
    this.leanCur += (this.lean - this.leanCur) * Math.min(1, dt * 3);
    this.talkCur += (this.talkLevel - this.talkCur) * Math.min(1, dt * 8);

    // 说话时的偶发点头：音量持续时每 1.5~3s 一次小幅点头
    let nodAmt = 0;
    if (this.nodPhase >= 0) {
      this.nodPhase += dt;
      const p = this.nodPhase / 0.5;
      if (p >= 1) this.nodPhase = -1;
      else nodAmt = Math.sin(p * Math.PI) * 0.06;
    } else if (this.talkCur > 0.3 && t > this.nextNodAt) {
      this.nodPhase = 0;
      this.nextNodAt = t + 1.5 + Math.random() * 1.5;
    }

    if (this.hips) {
      this.hips.position.y =
        this.hipsRestY + (breath - 0.5) * 0.03 + Math.sin(t * 8) * 0.008 * this.talkCur;
      this.hips.position.x = shift * 0.016;
      // 缓慢的身体横摆，制造 3D 体积感；重心转移时髋部侧倾；叠加倾身
      this.hips.rotation.y = Math.sin(t * 0.6) * 0.08;
      this.hips.rotation.z = shift * 0.04 + this.leanCur * 0.1;
    }
    if (this.spine) {
      this.spine.rotation.x =
        this.spineRestX + (breath - 0.5) * 0.07 + nodAmt;
      // 脊柱反向微摆，与髋部形成自然的对抗平衡
      this.spine.rotation.z = -shift * 0.035 + this.leanCur * 0.06;
      this.spine.rotation.y = -Math.sin(t * 0.6) * 0.04;
    }
    // 头部微倾：每 4~8s 换一个随机微倾目标，慢速过渡（lookAt 不控制颈骨，无冲突）。
    // 注意必须「内部状态缓动 + 绝对写入」：若读取当前旋转做缓动（r.x += (target-r.x)*k），
    // ActionPlayer 每帧叠加的动作量会被缓动反复拉回再叠加，平衡时放大 1/k 倍（点头变栽头）
    if (this.neck) {
      if (t > this.nextTiltAt) {
        this.neckTarget = {
          x: (Math.random() - 0.5) * 0.1,
          y: (Math.random() - 0.5) * 0.12,
          z: (Math.random() - 0.5) * 0.16,
        };
        this.nextTiltAt = t + 4 + Math.random() * 4;
      }
      const k = Math.min(1, dt * 1.5);
      this.neckCur.x += (this.neckTarget.x - this.neckCur.x) * k;
      this.neckCur.y += (this.neckTarget.y - this.neckCur.y) * k;
      this.neckCur.z += (this.neckTarget.z - this.neckCur.z) * k;
      this.neck.rotation.x = this.neckRest.x + this.neckCur.x;
      this.neck.rotation.y = this.neckRest.y + this.neckCur.y;
      this.neck.rotation.z = this.neckRest.z + this.neckCur.z;
    }
    // 手臂随身体摆动，相位略微滞后（跟随动作）
    const sway = Math.sin(t * 0.6 - 0.5) * 0.05;
    if (this.lArm) this.lArm.rotation.z = this.lArmRestZ + sway;
    if (this.rArm) this.rArm.rotation.z = this.rArmRestZ - sway;

    // 随机眨眼（2-6 秒间隔，15% 概率快速连眨两下）
    const expr = this.vrm.expressionManager;
    if (!expr) return;
    if (this.blinkPhase === null && t > this.nextBlinkAt) this.blinkPhase = 0;
    if (this.blinkPhase !== null) {
      this.blinkPhase += dt;
      const half = 0.12;
      let value: number;
      if (this.blinkPhase < half) {
        value = this.blinkPhase / half;
      } else if (this.blinkPhase < half * 2) {
        value = 1 - (this.blinkPhase - half) / half;
      } else {
        value = 0;
        this.blinkPhase = null;
        this.nextBlinkAt =
          Math.random() < 0.15 ? t + 0.35 : t + 2 + Math.random() * 4;
      }
      expr.setValue("blink", value);
    }
  }
}

/**
 * 手工关键帧片段播放器：AnimationMixer 封装。
 * 片段间 0.25s 交叉淡入淡出；播完自动淡出，骨骼交还待机/动作系统。
 * 长短分流：dance 标记的片段（舞蹈类长动作）不进随机池、不截断，完整播放；
 * 短片段 LoopOnce 自然结束（clampWhenFinished + finished 淡出）。
 */
export class ClipPlayer {
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private danceSet = new Set<string>();
  private current: THREE.AnimationAction | null = null;

  constructor(vrm: VRM, clips: Map<string, { clip: THREE.AnimationClip; dance: boolean }>) {
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    for (const [name, entry] of clips) {
      const action = this.mixer.clipAction(entry.clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.actions.set(name, action);
      if (entry.dance) this.danceSet.add(name);
    }
    this.mixer.addEventListener("finished", (e) => {
      if (e.action === this.current) {
        e.action.fadeOut(0.35);
        this.current = null;
      }
    });
  }

  get playing(): boolean {
    return this.current !== null;
  }

  get names(): string[] {
    return [...this.actions.keys()];
  }

  /** 短动作名列表（排除舞蹈）：双击随机、自主行为从这里挑，避免随机到整段舞蹈 */
  get shortNames(): string[] {
    return this.names.filter((n) => !this.danceSet.has(n));
  }

  isDance(name: string): boolean {
    return this.danceSet.has(name);
  }

  /** 运行时更新舞蹈标记（设置页切换 motionMeta 后即时生效，无需重载模型） */
  setDance(name: string, dance: boolean) {
    if (dance) this.danceSet.add(name);
    else this.danceSet.delete(name);
  }

  play(name: string) {
    const next = this.actions.get(name);
    if (!next || next === this.current) return;
    next.reset().fadeIn(0.25).play();
    this.current?.fadeOut(0.25);
    this.current = next;
  }

  /** 打断当前片段（淡出），供预览切换/模型卸载前清理 */
  stop() {
    this.current?.fadeOut(0.25);
    this.current = null;
  }

  update(dt: number) {
    this.mixer.update(dt);
  }
}

/**
 * 自主行为引擎：没人互动时宠物自己找事做。
 * 每 15-40 秒从「设置里启用的」动作池随机挑一件事做；
 * 正在播放动作/片段、打哈欠中或对话进行中（busy）时不打扰。
 */
export class BehaviorEngine {
  private elapsed = 0;
  private nextActionAt: number;
  private yawnT = -1;
  private hasAa: boolean;

  constructor(
    private actions: ActionPlayer,
    private vrm: VRM,
    private clips: ClipPlayer | undefined,
    /** 启用的动作 id 集合（实时读取，设置改动即刻生效） */
    private enabled: () => Set<string>
  ) {
    this.nextActionAt = this.pickDelay();
    this.hasAa = !!vrm.expressionManager?.getExpression("aa");
  }

  private pickDelay() {
    return 15 + Math.random() * 25;
  }

  /** 立即触发一次打哈欠（设置页预览用）；已在打哈欠或模型无 aa 表情时忽略 */
  yawn() {
    if (this.hasAa && this.yawnT < 0) this.yawnT = 0;
  }

  update(dt: number, busy: boolean) {
    const expr = this.vrm.expressionManager;

    // 打哈欠时间线：张嘴缓入缓出，眼睛中段闭上（约 2.6s）
    if (this.yawnT >= 0 && expr) {
      this.yawnT += dt;
      const p = this.yawnT / 2.6;
      if (p >= 1) {
        this.yawnT = -1;
        expr.setValue("aa", 0);
        expr.setValue("blink", 0);
      } else {
        const mouth = easeInOut(p / 0.3) * easeInOut((1 - p) / 0.35);
        const eyes = easeInOut((p - 0.15) / 0.2) * easeInOut((1 - p) / 0.3);
        expr.setValue("aa", mouth * 0.7);
        expr.setValue("blink", Math.min(1, eyes));
      }
    }

    if (busy || this.actions.playing || this.yawnT >= 0 || this.clips?.playing) return;
    this.elapsed += dt;
    if (this.elapsed < this.nextActionAt) return;
    this.elapsed = 0;
    this.nextActionAt = this.pickDelay();

    // 从启用的动作里加权组池：哈欠/短片段权重高些；舞蹈不进随机池
    const en = this.enabled();
    const pool: string[] = [];
    if (en.has("yawn") && this.hasAa) pool.push("yawn", "yawn");
    if (this.clips) {
      for (const n of this.clips.shortNames) {
        if (en.has(`clip:${n}`)) pool.push(`clip:${n}`, `clip:${n}`);
      }
    }
    for (const a of ["nod", "doze", "bounce", "shake", "wave", "knock"]) {
      if (en.has(a)) pool.push(a);
    }
    if (pool.length === 0) return;

    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick === "yawn") this.yawnT = 0;
    else if (pick.startsWith("clip:")) this.clips!.play(pick.slice(5));
    else this.actions.play(pick as ActionName);
  }
}
