import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Plane, Raycaster, Vector2, Vector3, type Mesh } from 'three';
import type { LayoutGeometry } from './model';
import type { ReviewFootprint } from './review-model';
import { componentAt } from './polygons';

/** Read-only diagnostic attachment, enabled only by ?review-debug=1. */
export function ReviewProbe({ host, footprints, geometry, referenceZ }: {
  host: React.RefObject<HTMLDivElement | null>; footprints: ReviewFootprint[]; geometry: LayoutGeometry; referenceZ: number;
}) {
  const { camera, scene, gl } = useThree();
  useLayoutEffect(() => {
    const target = host.current as (HTMLDivElement & { reviewProbe?: (x: number, y: number) => unknown; reviewCapture?: () => string }) | null;
    if (!target) return;
    const ray = new Raycaster(), plane = new Plane(new Vector3(0, 0, 1), -referenceZ);
    const center = { x: geometry.glass6066.x + geometry.glass6066.width / 2, y: geometry.glass6066.y + geometry.glass6066.height / 2 };
    const xy = (p: Vector3) => ({ x: p.x + center.x, y: center.y - p.y });
    target.reviewCapture = () => { gl.render(scene, camera); return gl.domElement.toDataURL('image/png'); };
    target.reviewProbe = (clientX, clientY) => {
      const rect = gl.domElement.getBoundingClientRect();
      ray.setFromCamera(new Vector2((clientX-rect.left)/rect.width*2-1, 1-(clientY-rect.top)/rect.height*2), camera);
      const point = ray.ray.intersectPlane(plane, new Vector3());
      const reference = point ? xy(point) : null;
      return {
        reference,
        referenceLayers: reference ? footprints.filter((f) => ['tio2','pt','seal'].includes(f.kind) && componentAt(reference, f.polygons) >= 0).map((f) => f.id) : [],
        hits: ray.intersectObjects(scene.children, true).filter((hit) => (hit.object as Mesh).isMesh && hit.object.userData.reviewLayerId).map((hit) => {
          const id = hit.object.userData.reviewLayerId as string, footprint = footprints.find((f) => f.id === id)!;
          const position = xy(hit.point);
          return { id, kind: footprint.kind, plate: footprint.plate, xy: position, z: hit.point.z,
            normalZ: hit.face?.normal.z, insideCanonicalXY: componentAt(position, footprint.polygons) >= 0 };
        }),
      };
    };
    return () => { delete target.reviewProbe; delete target.reviewCapture; };
  }, [camera, scene, gl, host, footprints, geometry, referenceZ]);
  return null;
}
