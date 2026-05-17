import type { GraphNode } from "./canvasTypes";
import { NODE_HEIGHT, NODE_WIDTH } from "./GraphNodeCard";

export type CameraMode = "manual" | "follow";
export type FollowReason =
  | "row-activation"
  | "row-continue"
  | "same-row-shift"
  | "settled-handoff";

export interface CameraTransform {
  x: number;
  y: number;
  scale: number;
}

export interface FollowTarget {
  row: number;
  anchorNodeId: string;
  reason: FollowReason;
  startedAt: number;
}

export interface FollowNodeState {
  row: number;
  active: boolean;
  settled: boolean;
}

export interface FollowCameraState {
  currentTarget: FollowTarget | null;
  queuedTarget: FollowTarget | null;
  previousNodeState: Record<string, FollowNodeState>;
  activeRows: number[];
}

export interface RowBounds {
  row: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  center: { x: number; y: number };
  anchorCenter: { x: number; y: number };
}

interface PositionedNode {
  id: string;
  row: number;
}

interface FollowResolution {
  state: FollowCameraState;
  nextTarget: FollowTarget | null;
  changed: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isActiveFollowDriver(node: GraphNode): boolean {
  if (node.kind === "tool") {
    return node.isLive || node.toolStatus === "running" || node.toolStatus === "retrying";
  }
  return node.status === "active" || node.status === "thinking";
}

function isSettledFollowDriver(node: GraphNode): boolean {
  if (node.kind === "tool") {
    return node.toolStatus === "success" || node.toolStatus === "failed" || node.status === "done" || node.status === "error";
  }
  return node.status === "done" || node.status === "error";
}

function chooseAnchor(nodes: GraphNode[], row: number): GraphNode | null {
  const rowNodes = nodes
    .filter((node) => node.row === row && isActiveFollowDriver(node))
    .sort((left, right) => left.col - right.col);
  return rowNodes[0] ?? null;
}

function makeTarget(node: GraphNode, reason: FollowReason, startedAt: number): FollowTarget {
  return {
    row: node.row,
    anchorNodeId: node.id,
    reason,
    startedAt,
  };
}

function sameTarget(left: FollowTarget | null, right: FollowTarget | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.row === right.row && left.anchorNodeId === right.anchorNodeId && left.reason === right.reason;
}

export function resolveFollowCameraState(
  previous: FollowCameraState,
  nodes: GraphNode[],
  now: number,
): FollowResolution {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const currentNodeState: Record<string, FollowNodeState> = {};
  const activeRowsSet = new Set<number>();
  const newlySettled: GraphNode[] = [];

  for (const node of nodes) {
    const active = isActiveFollowDriver(node);
    const settled = isSettledFollowDriver(node);
    currentNodeState[node.id] = { row: node.row, active, settled };
    if (active) {
      activeRowsSet.add(node.row);
    }
    const previousState = previous.previousNodeState[node.id];
    if (previousState?.active && settled) {
      newlySettled.push(node);
    }
  }

  const activeRows = [...activeRowsSet].sort((left, right) => left - right);
  const previousActiveRows = new Set(previous.activeRows);
  const newActiveRows = activeRows.filter((row) => !previousActiveRows.has(row));

  let queuedTarget = previous.queuedTarget;
  let nextTarget = previous.currentTarget;

  if (newlySettled.length > 0) {
    const preferredSettled = [...newlySettled].sort((left, right) => right.row - left.row || left.col - right.col)[0];
    if (
      !nextTarget
      || preferredSettled.row !== nextTarget.row
      || preferredSettled.id !== nextTarget.anchorNodeId
    ) {
      queuedTarget = makeTarget(preferredSettled, "settled-handoff", now);
    }
  }

  if (newActiveRows.length > 0) {
    const winningRow = Math.max(...newActiveRows);
    const anchor = chooseAnchor(nodes, winningRow);
    if (anchor) {
      nextTarget = makeTarget(anchor, "row-activation", now);
    }
  } else if (nextTarget) {
    const anchorState = currentNodeState[nextTarget.anchorNodeId];
    const anchorNode = nodesById.get(nextTarget.anchorNodeId);
    if (anchorState?.active && anchorNode?.row === nextTarget.row) {
      const sameRowNewlyActive = nodes
        .filter((node) => (
          node.row === nextTarget?.row
          && node.id !== nextTarget?.anchorNodeId
          && isActiveFollowDriver(node)
          && !previous.previousNodeState[node.id]?.active
        ))
        .sort((left, right) => left.col - right.col)[0];
      if (sameRowNewlyActive) {
        nextTarget = makeTarget(sameRowNewlyActive, "same-row-shift", now);
      }
    } else {
      const sameRowActive = nodes
        .filter((node) => node.row === nextTarget?.row && node.id !== nextTarget?.anchorNodeId && isActiveFollowDriver(node))
        .sort((left, right) => left.col - right.col)[0];
      if (sameRowActive) {
        nextTarget = makeTarget(sameRowActive, "same-row-shift", now);
      } else if (queuedTarget) {
        nextTarget = {
          ...queuedTarget,
          startedAt: now,
        };
        queuedTarget = null;
      } else {
        const sameRowSettled = nodes
          .filter((node) => node.row === nextTarget?.row && node.id !== nextTarget?.anchorNodeId && isSettledFollowDriver(node))
          .sort((left, right) => left.col - right.col)[0];
        if (sameRowSettled) {
          nextTarget = makeTarget(sameRowSettled, "same-row-shift", now);
        } else {
          nextTarget = null;
        }
      }
    }
  } else if (activeRows.length > 0) {
    const winningRow = Math.max(...activeRows);
    const anchor = chooseAnchor(nodes, winningRow);
    if (anchor) {
      nextTarget = makeTarget(anchor, "row-activation", now);
    }
  } else if (queuedTarget) {
    nextTarget = {
      ...queuedTarget,
      startedAt: now,
    };
    queuedTarget = null;
  }

  const changed = !sameTarget(previous.currentTarget, nextTarget);

  return {
    state: {
      currentTarget: nextTarget,
      queuedTarget,
      previousNodeState: currentNodeState,
      activeRows,
    },
    nextTarget,
    changed,
  };
}

export function computeRowBounds(
  nodes: PositionedNode[],
  positions: Map<string, { x: number; y: number }>,
  nodeHeights: Map<string, number>,
  anchorNodeId: string,
): RowBounds | null {
  if (nodes.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let anchorCenter = { x: 0, y: 0 };
  let row = nodes[0]?.row ?? 0;

  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const height = nodeHeights.get(node.id) ?? NODE_HEIGHT;
    const nodeMinX = position.x;
    const nodeMaxX = position.x + NODE_WIDTH;
    const nodeMinY = position.y;
    const nodeMaxY = position.y + height;
    minX = Math.min(minX, nodeMinX);
    maxX = Math.max(maxX, nodeMaxX);
    minY = Math.min(minY, nodeMinY);
    maxY = Math.max(maxY, nodeMaxY);
    row = node.row;
    if (node.id === anchorNodeId) {
      anchorCenter = {
        x: position.x + NODE_WIDTH / 2,
        y: position.y + height / 2,
      };
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return null;
  }

  return {
    row,
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
    },
    anchorCenter,
  };
}

export function computeFollowTransform(
  bounds: RowBounds,
  viewport: { width: number; height: number },
  current: CameraTransform,
): CameraTransform {
  const horizontalPadding = 110;
  const desiredScale = clamp(
    (viewport.width - 2 * horizontalPadding) / Math.max(bounds.width, NODE_WIDTH),
    0.72,
    1.05,
  );

  const rowFullyVisible =
    bounds.minX * current.scale + current.x >= horizontalPadding * 0.5
    && bounds.maxX * current.scale + current.x <= viewport.width - horizontalPadding * 0.5;

  const scale =
    rowFullyVisible && Math.abs(current.scale - desiredScale) <= 0.12
      ? current.scale
      : desiredScale;

  const anchorBiasX = bounds.center.x * 0.35 + bounds.anchorCenter.x * 0.65;
  const desiredScreenX = viewport.width * 0.52;
  const desiredScreenY = viewport.height * 0.4;

  return {
    x: desiredScreenX - anchorBiasX * scale,
    y: desiredScreenY - bounds.center.y * scale,
    scale,
  };
}
