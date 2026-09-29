import * as THREE from "three";
import * as fs from "fs";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  VRM,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import { ActionPlayer, IdleAnimator } from "/Users/wyw/CodeBuddy/ai-project/sloth-pet/src/pet/animations";

const buf = fs.readFileSync("/tmp/pet_notex.vrm");
const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

const gltf = await new Promise<any>((res, rej) =>
  loader.parse(arrayBuffer, "", res, rej)
);
const model = gltf.userData.vrm as VRM;
const scene = new THREE.Scene();
scene.add(model.scene);
VRMUtils.rotateVRM0(model);

const get = (n: VRMHumanBoneName) =>
  model.humanoid?.getNormalizedBoneNode(n) ?? null;

// 头部尺寸归一化（同 PetCanvas）
{
  const hb = get(VRMHumanBoneName.Head);
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

// 垂手修正（同 PetCanvas）
const dropArm = (upper: VRMHumanBoneName, lower: VRMHumanBoneName) => {
  const u = get(upper);
  const l = get(lower);
  if (!u || !l || !u.parent) return;
  model.scene.updateMatrixWorld(true);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  u.getWorldPosition(a);
  l.getWorldPosition(b);
  const dir = b.sub(a).normalize();
  if (dir.y < -0.55) return;
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

const probeSign = (
  bone: VRMHumanBoneName,
  child: VRMHumanBoneName,
  axis: "x" | "z",
  delta: number
): number => {
  const b = get(bone);
  const c = get(child);
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
const spineSign = probeSign(VRMHumanBoneName.Spine, VRMHumanBoneName.Head, "x", 0.1);
const neckSign = probeSign(VRMHumanBoneName.Neck, VRMHumanBoneName.Head, "x", 0.1);
console.log("spineSign =", spineSign, " neckSign =", neckSign);

const player = new ActionPlayer(model, { spineSign, neckSign });
const idle = new IdleAnimator(model);

const rawHead = model.humanoid!.getRawBoneNode(VRMHumanBoneName.Head)!;
const rawNeck = model.humanoid!.getRawBoneNode(VRMHumanBoneName.Neck)!;
const rawHand = model.humanoid!.getRawBoneNode(VRMHumanBoneName.RightHand)!;

const headPos = new THREE.Vector3();
const neckPos = new THREE.Vector3();
const handPos = new THREE.Vector3();
const headQ = new THREE.Quaternion();

function report(tag: string) {
  model.scene.updateMatrixWorld(true);
  rawHead.getWorldPosition(headPos);
  rawNeck.getWorldPosition(neckPos);
  const d = headPos.clone().sub(neckPos).normalize(); // 应≈+Y；前栽=+Z，后仰=-Z
  const nNeck = get(VRMHumanBoneName.Neck)!;
  console.log(
    tag,
    "neck->head dir:",
    d.toArray().map((v) => v.toFixed(2)).join(","),
    "| neck euler x/y/z:",
    nNeck.rotation.x.toFixed(2),
    nNeck.rotation.y.toFixed(2),
    nNeck.rotation.z.toFixed(2)
  );
}

const dt = 1 / 60;
const action = process.argv[2] ?? "doze";
console.log("=== action:", action, "===");
player.play(action as any);
for (let i = 0; i <= 200 && player.playing; i++) {
  idle.update(dt);
  player.update(dt);
  model.update(dt);
  if (i % 12 === 0) report(`t=${(i * dt).toFixed(2)}`);
}
report("end");

if (action === "wave") {
  console.log("--- wave upper/fore dir trajectory ---");
  const rawElbow = model.humanoid!.getRawBoneNode(VRMHumanBoneName.RightLowerArm)!;
  const rawUpper = model.humanoid!.getRawBoneNode(VRMHumanBoneName.RightUpperArm)!;
  const elbowPos = new THREE.Vector3();
  const upperPos = new THREE.Vector3();
  const aim = (player as any).armAim;
  console.log(
    "armAim.restDir:",
    aim.restDir.toArray().map((v: number) => v.toFixed(2)).join(","),
    "side:",
    aim.side
  );
  player.play("wave" as any);
  for (let i = 0; i <= 140 && player.playing; i++) {
    idle.update(dt);
    player.update(dt);
    model.update(dt);
    if (i % 10 === 0) {
      model.scene.updateMatrixWorld(true);
      rawHand.getWorldPosition(handPos);
      rawElbow.getWorldPosition(elbowPos);
      rawUpper.getWorldPosition(upperPos);
      const upperDir = elbowPos.clone().sub(upperPos).normalize();
      const foreDir = handPos.clone().sub(elbowPos).normalize();
      console.log(
        `t=${(i * dt).toFixed(2)} upperDir:`,
        upperDir.toArray().map((v) => v.toFixed(2)).join(","),
        "foreDir:",
        foreDir.toArray().map((v) => v.toFixed(2)).join(",")
      );
    }
  }
}
