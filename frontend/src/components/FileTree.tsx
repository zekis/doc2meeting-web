import { useMemo, useState } from "react";
import { FileTreeNode } from "../api";

interface Props {
  tree: FileTreeNode;
  rootLabel?: string;
  /** rel_path of the currently-open document. Highlighted. */
  activePath?: string | null;
  /** rel_paths currently flagged as context. Renders checkboxes when provided. */
  contextPaths?: string[];
  onSelectFile?: (relPath: string) => void;
  onToggleContext?: (relPath: string, on: boolean) => void;
  /** Convert a .docx to markdown. When provided, a small ↻md button shows
   *  next to every .docx file in the tree. */
  onConvertDocx?: (relPath: string) => Promise<void> | void;
  /** Initial folder expansion — when true, top-level folders open by default;
   *  otherwise everything starts collapsed (excluding the path of an active doc,
   *  which auto-expands so you can see where you are). */
  defaultExpanded?: boolean;
}

/**
 * Recursive folder tree. Folders show a ▸/▾ disclosure; files show a button.
 * If `contextPaths` and `onToggleContext` are provided, each file gets a
 * checkbox to flag it as context for the open document.
 */
export function FileTree({
  tree,
  rootLabel,
  activePath,
  contextPaths,
  onSelectFile,
  onToggleContext,
  onConvertDocx,
  defaultExpanded = false,
}: Props) {
  const ctxSet = useMemo(() => new Set(contextPaths ?? []), [contextPaths]);

  // Tree root is the ROOT_DIR itself; render its children directly so the user
  // doesn't see a vestigial "root" entry.
  const children = tree.children ?? [];

  return (
    <div className="file-tree">
      {rootLabel && <div className="file-tree-root">{rootLabel}</div>}
      <ul className="file-tree-list">
        {children.map((c) => (
          <TreeNode
            key={c.rel_path || c.name}
            node={c}
            depth={0}
            defaultExpanded={defaultExpanded}
            activePath={activePath ?? null}
            ctxSet={ctxSet}
            onSelectFile={onSelectFile}
            onToggleContext={onToggleContext}
            onConvertDocx={onConvertDocx}
          />
        ))}
      </ul>
    </div>
  );
}

interface NodeProps {
  node: FileTreeNode;
  depth: number;
  defaultExpanded: boolean;
  activePath: string | null;
  ctxSet: Set<string>;
  onSelectFile?: (relPath: string) => void;
  onToggleContext?: (relPath: string, on: boolean) => void;
  onConvertDocx?: (relPath: string) => Promise<void> | void;
}

function TreeNode({
  node,
  depth,
  defaultExpanded,
  activePath,
  ctxSet,
  onSelectFile,
  onToggleContext,
  onConvertDocx,
}: NodeProps) {
  const [converting, setConverting] = useState(false);
  // Top-level folders open by default; nested ones collapsed unless the active
  // path lives inside them.
  const initiallyOpen =
    defaultExpanded && depth === 0
      ? true
      : activePath
      ? activePath.startsWith(node.rel_path + "/")
      : false;
  const [open, setOpen] = useState(initiallyOpen);
  const indent = { paddingLeft: `${depth * 0.85 + 0.4}rem` };

  if (node.type === "folder") {
    return (
      <li className="file-tree-folder">
        <button
          className="file-tree-row file-tree-folder-row"
          style={indent}
          onClick={() => setOpen((v) => !v)}
          title={node.rel_path}
        >
          <span className="file-tree-chev">{open ? "▾" : "▸"}</span>
          <span className="file-tree-icon">📁</span>
          <span className="file-tree-name">{node.name}</span>
        </button>
        {open && (
          <ul className="file-tree-list">
            {(node.children ?? []).map((c) => (
              <TreeNode
                key={c.rel_path || c.name}
                node={c}
                depth={depth + 1}
                defaultExpanded={defaultExpanded}
                activePath={activePath}
                ctxSet={ctxSet}
                onSelectFile={onSelectFile}
                onToggleContext={onToggleContext}
                onConvertDocx={onConvertDocx}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isActive = activePath === node.rel_path;
  const isCtx = ctxSet.has(node.rel_path);
  const isDocx = node.name.toLowerCase().endsWith(".docx");

  const handleConvert = async () => {
    if (!onConvertDocx || converting) return;
    setConverting(true);
    try {
      await onConvertDocx(node.rel_path);
    } finally {
      setConverting(false);
    }
  };

  return (
    <li className="file-tree-file">
      <div
        className={`file-tree-row file-tree-file-row ${isActive ? "active" : ""} ${isDocx ? "is-docx" : ""}`}
        style={indent}
      >
        {onToggleContext && !isDocx && (
          <input
            type="checkbox"
            className="file-tree-ctx"
            checked={isCtx}
            onChange={(e) => onToggleContext(node.rel_path, e.target.checked)}
            title="Use as context for the reviewer"
            onClick={(e) => e.stopPropagation()}
          />
        )}
        <button
          className="file-tree-name-btn"
          onClick={() => {
            if (isDocx) return; // .docx isn't openable — convert instead
            onSelectFile?.(node.rel_path);
          }}
          disabled={isDocx}
          title={isDocx ? "Convert to markdown to review" : node.rel_path}
        >
          <span className="file-tree-icon">{isDocx ? "📘" : "📄"}</span>
          <span className="file-tree-name">{node.name}</span>
        </button>
        {isDocx && onConvertDocx && (
          <button
            className="file-tree-convert-btn"
            onClick={handleConvert}
            disabled={converting}
            title="Convert this .docx to a sibling .md file"
          >
            {converting ? "…" : "↻ md"}
          </button>
        )}
      </div>
    </li>
  );
}
