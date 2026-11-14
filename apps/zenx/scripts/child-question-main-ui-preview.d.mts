/** Measurement contract consumed by the strict TypeScript fixture tests. */
export interface ChildQuestionRect {
  width: number;
  height: number;
  visible: boolean;
  viewportIntersection: { width: number; height: number };
}
export interface ChildQuestionMeasurement {
  sidebar: Array<{
    id: string;
    badge: string | null;
    rect: ChildQuestionRect;
  }>;
  rows: Array<{
    id: string;
    title: string | undefined;
    status: string;
    rect: ChildQuestionRect;
  }>;
  dock: { width: number; bottom: number };
  composer: { width: number };
  overflow: number;
}
export function verifyChildQuestions(
  state: ChildQuestionMeasurement,
  cleared?: boolean,
): void;
