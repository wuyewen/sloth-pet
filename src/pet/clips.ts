import * as THREE from "three";
import { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";

/**
 * 手工关键帧动画：每段动作是一组"时间点 → 骨骼姿态"的数据，
 * 编译成 THREE.AnimationClip 由 AnimationMixer 播放（与加载 VRMA 效果相同）。
 *
 * 骨骼旋转是叠加在静止位姿上的增量（弧度，XYZ 欧拉角），因此对不同模型通用：
 * 增量为零 = 保持模型自身静止姿态。
 */

export interface ClipKey {
  time: number;
  /** 骨骼 → 欧拉角增量 [x, y, z] */
  bones?: Partial<Record<VRMHumanBoneName, [number, number, number]>>;
  /** 骨骼 → 局部位移增量（一般只用于 hips） */
  pos?: Partial<Record<VRMHumanBoneName, [number, number, number]>>;
}

export interface ClipDef {
  name: string;
  duration: number;
  keys: ClipKey[];
}

const { Hips, Spine, RightUpperArm, RightLowerArm, LeftUpperArm, LeftLowerArm } =
  VRMHumanBoneName;

/** 伸懒腰：预备下蹲 → 双臂上举（微颤保持）→ 过冲回弹放松（幅度按小窗口桌宠调校，避免夸张） */
const STRETCH: ClipDef = {
  name: "stretch",
  duration: 3.0,
  keys: [
    { time: 0.0, bones: { [Spine]: [0, 0, 0], [RightUpperArm]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0], [RightLowerArm]: [0, 0, 0], [LeftLowerArm]: [0, 0, 0] }, pos: { [Hips]: [0, 0, 0] } },
    { time: 0.4, bones: { [Spine]: [0.1, 0, 0], [RightUpperArm]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0], [RightLowerArm]: [0, 0, 0], [LeftLowerArm]: [0, 0, 0] }, pos: { [Hips]: [0, -0.03, 0] } },
    { time: 0.9, bones: { [Spine]: [-0.12, 0, 0], [RightUpperArm]: [0, 0, -1.7], [LeftUpperArm]: [0, 0, 1.7], [RightLowerArm]: [0, 0, -0.35], [LeftLowerArm]: [0, 0, 0.35] }, pos: { [Hips]: [0, 0.02, 0] } },
    // 保持阶段的微颤
    { time: 1.15, bones: { [RightUpperArm]: [0, 0, -1.75], [LeftUpperArm]: [0, 0, 1.75] } },
    { time: 1.3, bones: { [RightUpperArm]: [0, 0, -1.65], [LeftUpperArm]: [0, 0, 1.65] } },
    { time: 1.45, bones: { [RightUpperArm]: [0, 0, -1.72], [LeftUpperArm]: [0, 0, 1.72] } },
    { time: 1.7, bones: { [RightUpperArm]: [0, 0, -1.7], [LeftUpperArm]: [0, 0, 1.7], [RightLowerArm]: [0, 0, -0.35], [LeftLowerArm]: [0, 0, 0.35], [Spine]: [-0.12, 0, 0] }, pos: { [Hips]: [0, 0.02, 0] } },
    // 放下时略过静止位再回弹
    { time: 2.3, bones: { [Spine]: [0.04, 0, 0], [RightUpperArm]: [0, 0, 0.1], [LeftUpperArm]: [0, 0, -0.1], [RightLowerArm]: [0, 0, 0], [LeftLowerArm]: [0, 0, 0] }, pos: { [Hips]: [0, 0, 0] } },
    { time: 2.7, bones: { [Spine]: [0, 0, 0], [RightUpperArm]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0], [RightLowerArm]: [0, 0, 0], [LeftLowerArm]: [0, 0, 0] }, pos: { [Hips]: [0, 0, 0] } },
  ],
};

/** 兴奋摇摆：身体左右扭动两次、手臂张开扑腾，最后小跳收尾 */
const EXCITED: ClipDef = {
  name: "excited",
  duration: 1.9,
  keys: [
    { time: 0.0, bones: { [Hips]: [0, 0, 0], [Spine]: [0, 0, 0], [RightUpperArm]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0] }, pos: { [Hips]: [0, 0, 0] } },
    { time: 0.2, bones: { [Hips]: [0, 0, 0.09], [Spine]: [0, 0, 0.06], [RightUpperArm]: [0, 0, -0.5], [LeftUpperArm]: [0, 0, 0.2] }, pos: { [Hips]: [0.04, 0, 0] } },
    { time: 0.45, bones: { [Hips]: [0, 0, -0.09], [Spine]: [0, 0, -0.06], [RightUpperArm]: [0, 0, -0.2], [LeftUpperArm]: [0, 0, 0.5] }, pos: { [Hips]: [-0.04, 0, 0] } },
    { time: 0.7, bones: { [Hips]: [0, 0, 0.11], [Spine]: [0, 0, 0.07], [RightUpperArm]: [0, 0, -0.6], [LeftUpperArm]: [0, 0, 0.25] }, pos: { [Hips]: [0.05, 0, 0] } },
    { time: 0.95, bones: { [Hips]: [0, 0, -0.11], [Spine]: [0, 0, -0.07], [RightUpperArm]: [0, 0, -0.25], [LeftUpperArm]: [0, 0, 0.6] }, pos: { [Hips]: [-0.05, 0, 0] } },
    { time: 1.2, bones: { [Hips]: [0, 0, 0], [Spine]: [0, 0, 0], [RightUpperArm]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0] }, pos: { [Hips]: [0, 0.06, 0] } },
    { time: 1.35, bones: { [Hips]: [0, 0, 0], [Spine]: [0, 0, 0], [RightUpperArm]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0] }, pos: { [Hips]: [0, -0.02, 0] } },
    { time: 1.6, bones: { [Hips]: [0, 0, 0], [Spine]: [0, 0, 0], [RightUpperArm]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0] }, pos: { [Hips]: [0, 0, 0] } },
  ],
};

/** 思考挠头：右手举到头侧，前臂快速挠动数次，停留片刻后放下 */
const SCRATCH: ClipDef = {
  name: "scratch",
  duration: 2.7,
  keys: [
    { time: 0.0, bones: { [RightUpperArm]: [0, 0, 0], [RightLowerArm]: [0, 0, 0], [Spine]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0] } },
    { time: 0.5, bones: { [RightUpperArm]: [0, 0, -1.9], [RightLowerArm]: [0, 0, -2.3], [Spine]: [0, 0, 0.06], [LeftUpperArm]: [0, 0, 0.15] } },
    { time: 0.8, bones: { [RightLowerArm]: [0, 0, -2.15] } },
    { time: 1.0, bones: { [RightLowerArm]: [0, 0, -2.35] } },
    { time: 1.2, bones: { [RightLowerArm]: [0, 0, -2.15] } },
    { time: 1.4, bones: { [RightLowerArm]: [0, 0, -2.35] } },
    { time: 1.7, bones: { [RightUpperArm]: [0, 0, -1.9], [RightLowerArm]: [0, 0, -2.3], [Spine]: [0, 0, 0.08], [LeftUpperArm]: [0, 0, 0.15] } },
    { time: 2.2, bones: { [RightUpperArm]: [0, 0, 0.1], [RightLowerArm]: [0, 0, 0], [Spine]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0] } },
    { time: 2.5, bones: { [RightUpperArm]: [0, 0, 0], [RightLowerArm]: [0, 0, 0], [Spine]: [0, 0, 0], [LeftUpperArm]: [0, 0, 0] } },
  ],
};

export const CLIP_DEFS: ClipDef[] = [STRETCH, EXCITED, SCRATCH];

/**
 * 把关键帧数据编译成 AnimationClip。
 * 增量欧拉角右乘在骨骼静止四元数上，因此与模型自身的 rest pose 无关。
 * 骨骼不存在时跳过该骨骼；整段没有任何有效轨道则不产出。
 */
export function buildClips(vrm: VRM): Map<string, THREE.AnimationClip> {
  const result = new Map<string, THREE.AnimationClip>();
  const get = (n: VRMHumanBoneName) =>
    vrm.humanoid?.getNormalizedBoneNode(n) ?? null;

  for (const def of CLIP_DEFS) {
    const tracks: THREE.KeyframeTrack[] = [];
    const euler = new THREE.Euler();
    const delta = new THREE.Quaternion();

    const boneSet = new Set<VRMHumanBoneName>();
    for (const k of def.keys) {
      for (const b of Object.keys(k.bones ?? {})) boneSet.add(b as VRMHumanBoneName);
    }
    for (const bone of boneSet) {
      const node = get(bone);
      if (!node) continue;
      const rest = node.quaternion.clone();
      const times: number[] = [];
      const values: number[] = [];
      for (const k of def.keys) {
        const rot = k.bones?.[bone];
        if (!rot) continue;
        times.push(k.time);
        euler.set(rot[0], rot[1], rot[2]);
        delta.setFromEuler(euler);
        const q = rest.clone().multiply(delta);
        values.push(q.x, q.y, q.z, q.w);
      }
      if (times.length >= 2) {
        tracks.push(
          new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values)
        );
      }
    }

    const posSet = new Set<VRMHumanBoneName>();
    for (const k of def.keys) {
      for (const b of Object.keys(k.pos ?? {})) posSet.add(b as VRMHumanBoneName);
    }
    for (const bone of posSet) {
      const node = get(bone);
      if (!node) continue;
      const rest = node.position.clone();
      const times: number[] = [];
      const values: number[] = [];
      for (const k of def.keys) {
        const p = k.pos?.[bone];
        if (!p) continue;
        times.push(k.time);
        values.push(rest.x + p[0], rest.y + p[1], rest.z + p[2]);
      }
      if (times.length >= 2) {
        tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, times, values));
      }
    }

    if (tracks.length > 0) {
      result.set(def.name, new THREE.AnimationClip(def.name, def.duration, tracks));
    }
  }
  return result;
}
