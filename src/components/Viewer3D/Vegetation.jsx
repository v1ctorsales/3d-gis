import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const KIND_COLOR = {
  forest: "#2D6A4F",
  park: "#52B788",
  scrub: "#74C69D",
  meadow: "#B7E4C7",
};

const TRUNK_COLOR = new THREE.Color("#5C4033");

function addVertexColors(geom, color) {
  const count = geom.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

// Low-poly tree: a cylinder trunk + cone canopy merged into one geometry,
// with vertex colors so a single InstancedMesh can use one material.
function buildTreeGeometry(canopyColor) {
  const trunk = new THREE.CylinderGeometry(0.015, 0.02, 0.12, 6);
  trunk.translate(0, 0.06, 0);
  const canopy = new THREE.ConeGeometry(0.18, 0.35, 7);
  canopy.translate(0, 0.12 + 0.35 / 2, 0);

  addVertexColors(trunk, TRUNK_COLOR);
  addVertexColors(canopy, new THREE.Color(canopyColor));

  const merged = mergeGeometries([trunk, canopy]);
  trunk.dispose();
  canopy.dispose();
  return merged;
}

function TreeInstances({ kind, positions }) {
  const geometry = useMemo(() => buildTreeGeometry(KIND_COLOR[kind]), [kind]);
  const meshRef = useRef();

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    positions.forEach((p, i) => {
      m.makeTranslation(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [positions]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  if (positions.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, null, positions.length]}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial vertexColors roughness={0.9} metalness={0} />
    </instancedMesh>
  );
}

export default function Vegetation({ geometry }) {
  const groundParts = geometry?.groundParts;
  const treeInstances = geometry?.treeInstances;

  useEffect(
    () => () => groundParts?.forEach((p) => p.geometry?.dispose()),
    [groundParts],
  );

  if (!geometry) return null;

  return (
    <>
      {groundParts?.map((part) => (
        <mesh key={part.kind} geometry={part.geometry}>
          <meshLambertMaterial
            color={KIND_COLOR[part.kind]}
            side={THREE.DoubleSide}
            transparent
            opacity={0.6}
          />
        </mesh>
      ))}
      {treeInstances &&
        Object.entries(treeInstances).map(([kind, positions]) => (
          <TreeInstances key={kind} kind={kind} positions={positions} />
        ))}
    </>
  );
}
