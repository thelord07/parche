/** Expandable folder tree for the vault aside.
 *  Keyboard: ArrowUp/ArrowDown to move focus, ArrowRight to expand/open,
 *  ArrowLeft to collapse/go up, Enter to activate.
 *  Loads children lazily via api.getTree on first expand.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type TreeItem } from '../api.ts';

interface VaultTreeProps {
  slug: string;
}

interface FolderNode {
  name: string;
  path: string;
  type: 'dir';
  count: number;
  expanded: boolean;
  loading: boolean;
  children: TreeNode[] | null;
}

interface FileNode {
  name: string;
  path: string;
  type: 'file';
  title?: string;
}

type TreeNode = FolderNode | FileNode;

function buildPath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

function itemsToNodes(items: TreeItem[], parentPath: string): TreeNode[] {
  return items.map((item) => {
    const path = buildPath(parentPath, item.name);
    if (item.type === 'dir') {
      return {
        name: item.name,
        path,
        type: 'dir' as const,
        count: item.count ?? 0,
        expanded: false,
        loading: false,
        children: null,
      } satisfies FolderNode;
    }
    return {
      name: item.name,
      path,
      type: 'file' as const,
      title: item.title,
    } satisfies FileNode;
  });
}

interface NodeRowProps {
  node: TreeNode;
  depth: number;
  tabIndex: number;
  isFocused: boolean;
  onRef: (el: HTMLElement | null) => void;
  onToggle: (path: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>, node: TreeNode) => void;
  slug: string;
  currentPath: string;
}

function NodeRow({
  node,
  depth,
  tabIndex,
  isFocused: _isFocused,
  onRef,
  onToggle,
  onKeyDown,
  slug,
  currentPath,
}: NodeRowProps) {
  const indent = 8 + depth * 18;
  const isActive = node.type === 'file' && node.path === currentPath;

  if (node.type === 'dir') {
    const folder = node as FolderNode;
    return (
      <span
        role="treeitem"
        aria-expanded={folder.expanded}
        aria-level={depth + 1}
        tabIndex={tabIndex}
        ref={(el) => onRef(el)}
        onKeyDown={(e) => onKeyDown(e, node)}
        onClick={() => onToggle(folder.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 28,
          padding: `0 8px 0 ${indent}px`,
          borderRadius: 4,
          cursor: 'pointer',
          color: 'var(--text)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
          userSelect: 'none',
          outline: 'none',
        }}
        onFocus={(e) => {
          e.currentTarget.style.background = 'var(--card)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{
              transform: folder.expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.15s',
              flexShrink: 0,
            }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          {folder.name}/
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{folder.count}</span>
      </span>
    );
  }

  // File node
  return (
    <Link
      role="treeitem"
      aria-level={depth + 1}
      aria-current={isActive ? 'page' : undefined}
      tabIndex={tabIndex}
      ref={(el) => onRef(el as HTMLAnchorElement | null)}
      onKeyDown={(e) => onKeyDown(e, node)}
      to={`/g/${slug}/n/${node.path}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 28,
        padding: `0 8px 0 ${indent}px`,
        borderRadius: 4,
        background: isActive ? 'var(--card)' : 'transparent',
        color: isActive ? 'var(--text)' : 'var(--muted)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        textDecoration: 'none',
        outline: 'none',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      onMouseEnter={(e) => {
        if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg2)';
        (e.currentTarget as HTMLElement).style.color = 'var(--text)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
        (e.currentTarget as HTMLElement).style.color = isActive ? 'var(--text)' : 'var(--muted)';
      }}
    >
      {(node as FileNode).title ?? node.name}
    </Link>
  );
}

function flattenVisible(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.type === 'dir' && (node as FolderNode).expanded && (node as FolderNode).children) {
      result.push(...flattenVisible((node as FolderNode).children!));
    }
  }
  return result;
}

export function VaultTree({ slug }: VaultTreeProps) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusIdx, setFocusIdx] = useState(0);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const currentPath = window.location.pathname.replace(`/g/${slug}/n/`, '');

  useEffect(() => {
    api
      .getTree(slug)
      .then((r) => {
        setRoots(itemsToNodes(r.items, ''));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [slug]);

  const updateNodes = useCallback(
    (nodes: TreeNode[], targetPath: string, updater: (n: FolderNode) => FolderNode): TreeNode[] => {
      return nodes.map((node) => {
        if (node.path === targetPath && node.type === 'dir') {
          return updater(node as FolderNode);
        }
        if (node.type === 'dir' && (node as FolderNode).children) {
          return {
            ...(node as FolderNode),
            children: updateNodes((node as FolderNode).children!, targetPath, updater),
          };
        }
        return node;
      });
    },
    [],
  );

  const handleToggle = useCallback(
    async (path: string) => {
      // Find folder
      const flat = flattenVisible(roots);
      const folder = flat.find((n) => n.path === path && n.type === 'dir') as
        | FolderNode
        | undefined;
      if (!folder) return;

      if (folder.expanded) {
        // Collapse
        setRoots((prev) => updateNodes(prev, path, (f) => ({ ...f, expanded: false })));
        return;
      }

      if (folder.children !== null) {
        // Already loaded, just expand
        setRoots((prev) => updateNodes(prev, path, (f) => ({ ...f, expanded: true })));
        return;
      }

      // Load children
      setRoots((prev) => updateNodes(prev, path, (f) => ({ ...f, loading: true })));
      try {
        const r = await api.getTree(slug, path);
        const children = itemsToNodes(r.items, path);
        setRoots((prev) =>
          updateNodes(prev, path, (f) => ({
            ...f,
            expanded: true,
            loading: false,
            children,
          })),
        );
      } catch {
        setRoots((prev) => updateNodes(prev, path, (f) => ({ ...f, loading: false })));
      }
    },
    [roots, slug, updateNodes],
  );

  const flat = flattenVisible(roots);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>, node: TreeNode) => {
      const idx = flat.findIndex((n) => n.path === node.path);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(idx + 1, flat.length - 1);
        setFocusIdx(next);
        itemRefs.current.get(flat[next]?.path ?? '')?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(idx - 1, 0);
        setFocusIdx(prev);
        itemRefs.current.get(flat[prev]?.path ?? '')?.focus();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (node.type === 'dir') {
          const folder = node as FolderNode;
          if (!folder.expanded) {
            void handleToggle(folder.path);
          } else if (folder.children?.length) {
            // Move to first child
            const childIdx = flat.findIndex((n) => n.path === folder.children![0]?.path);
            if (childIdx !== -1) {
              setFocusIdx(childIdx);
              itemRefs.current.get(flat[childIdx]?.path ?? '')?.focus();
            }
          }
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (node.type === 'dir' && (node as FolderNode).expanded) {
          void handleToggle(node.path);
        } else {
          // Go to parent
          const parentPath = node.path.split('/').slice(0, -1).join('/');
          if (parentPath) {
            const parentIdx = flat.findIndex((n) => n.path === parentPath);
            if (parentIdx !== -1) {
              setFocusIdx(parentIdx);
              itemRefs.current.get(flat[parentIdx]?.path ?? '')?.focus();
            }
          }
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (flat.length > 0) {
          setFocusIdx(0);
          itemRefs.current.get(flat[0]?.path ?? '')?.focus();
        }
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = flat.length - 1;
        if (last >= 0) {
          setFocusIdx(last);
          itemRefs.current.get(flat[last]?.path ?? '')?.focus();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (node.type === 'dir') {
          void handleToggle(node.path);
        } else {
          // Navigate to note
          (e.currentTarget as HTMLAnchorElement).click();
        }
      }
    },
    [flat, handleToggle],
  );

  if (loading) {
    return (
      <nav
        aria-label="Árbol del vault"
        style={{
          padding: '8px',
          color: 'var(--muted)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
        }}
      >
        Cargando…
      </nav>
    );
  }

  function renderNodes(nodes: TreeNode[], depth: number): React.ReactNode {
    return nodes.map((node) => {
      const globalIdx = flat.findIndex((n) => n.path === node.path);
      return (
        <div key={node.path} role="none">
          <NodeRow
            node={node}
            depth={depth}
            tabIndex={focusIdx === globalIdx ? 0 : -1}
            isFocused={focusIdx === globalIdx}
            onRef={(el) => {
              if (el) itemRefs.current.set(node.path, el);
              // itemRefs is a transitory Map of DOM refs for keyboard nav;
              // deleting on unmount prevents stale refs from accumulating.
              else itemRefs.current.delete(node.path);
            }}
            onToggle={handleToggle}
            onKeyDown={handleKeyDown}
            slug={slug}
            currentPath={currentPath}
          />
          {node.type === 'dir' &&
            (node as FolderNode).expanded &&
            ((node as FolderNode).loading ? (
              <span
                style={{
                  display: 'block',
                  padding: `0 8px 0 ${8 + (depth + 1) * 18}px`,
                  height: 24,
                  lineHeight: '24px',
                  color: 'var(--muted)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                }}
              >
                …
              </span>
            ) : (
              (node as FolderNode).children !== null &&
              renderNodes((node as FolderNode).children!, depth + 1)
            ))}
        </div>
      );
    });
  }

  return (
    <div
      role="tree"
      aria-label="Árbol del vault"
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      {roots.length === 0 ? (
        <span style={{ padding: '8px 16px', color: 'var(--muted)', fontSize: 13 }}>
          Sin archivos
        </span>
      ) : (
        renderNodes(roots, 0)
      )}
    </div>
  );
}
