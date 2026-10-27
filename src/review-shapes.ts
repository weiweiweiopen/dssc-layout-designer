import { ExtrudeGeometry, Path, Shape, ShapeGeometry, Vector2 } from "three";
import type { Point, PolygonSet } from "./model";

/** SVG-style y-down mm -> centered, y-up mm. Keep every interior ring a hole. */
export function reviewShapes(polygons: PolygonSet, center: Point): Shape[] {
  const points = (ring: Point[]) => {
    const open = ring.length > 1 && ring[0].x === ring.at(-1)!.x && ring[0].y === ring.at(-1)!.y ? ring.slice(0, -1) : ring;
    return open.map((p) => new Vector2(p.x - center.x, center.y - p.y));
  };
  return polygons.filter((rings) => rings[0]?.length >= 3).map(([outer, ...holes]) => {
    const shape = new Shape(points(outer));
    shape.holes = holes.filter((hole) => hole.length >= 3).map((hole) => new Path(points(hole)));
    return shape;
  });
}
export function reviewMeshGeometry(polygons: PolygonSet, center: Point, depth: number) {
  const shapes = reviewShapes(polygons, center);
  return depth > 0
    ? new ExtrudeGeometry(shapes, { depth, bevelEnabled: false, steps: 1, curveSegments: 1 })
    : new ShapeGeometry(shapes);
}
