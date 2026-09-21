import { useState } from 'react';
import './Sidebar.css';

// Flat items render as before. Items with `children` render as an expandable
// parent menu: clicking the header toggles the sub-menu (chevron ▸/▾); a
// group containing the active module starts expanded. When the sidebar is
// collapsed the group renders as its icon, which selects the first sub-item.
function Sidebar({ modules, activeModule, onModuleChange, collapsed, onToggleCollapse }) {
  const [openGroups, setOpenGroups] = useState(
    () => new Set(modules.filter((m) => m.children?.some((c) => c.id === activeModule)).map((m) => m.id)),
  );

  const toggleGroup = (id) =>
    setOpenGroups((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        {!collapsed && <span className="sidebar-brand">🛠️ ddududu</span>}
        <button className="sidebar-toggle" onClick={onToggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '→' : '←'}
        </button>
      </div>
      <nav className="sidebar-nav">
        {modules.map((mod) => {
          if (!mod.children) {
            return (
              <button
                key={mod.id}
                className={`sidebar-item ${activeModule === mod.id ? 'active' : ''}`}
                onClick={() => onModuleChange(mod.id)}
                title={mod.label}
              >
                <span className="sidebar-item-icon">{mod.icon}</span>
                {!collapsed && <span className="sidebar-item-label">{mod.label}</span>}
              </button>
            );
          }
          const groupActive = mod.children.some((ch) => ch.id === activeModule);
          if (collapsed) {
            return (
              <button
                key={mod.id}
                className={`sidebar-item ${groupActive ? 'active' : ''}`}
                onClick={() => onModuleChange(mod.children[0].id)}
                title={mod.label}
              >
                <span className="sidebar-item-icon">{mod.icon}</span>
              </button>
            );
          }
          const open = openGroups.has(mod.id);
          return (
            <div key={mod.id} className="sidebar-group">
              <button
                type="button"
                className={`sidebar-group-head ${groupActive ? 'has-active' : ''}`}
                onClick={() => toggleGroup(mod.id)}
                title={open ? `Collapse ${mod.label}` : `Expand ${mod.label}`}
                aria-expanded={open}
              >
                <span className="sidebar-item-icon">{mod.icon}</span>
                <span className="sidebar-item-label">{mod.label}</span>
                <span className="sidebar-group-chevron">{open ? '▾' : '▸'}</span>
              </button>
              {open &&
                mod.children.map((ch) => (
                  <button
                    key={ch.id}
                    className={`sidebar-item sidebar-subitem ${activeModule === ch.id ? 'active' : ''}`}
                    onClick={() => onModuleChange(ch.id)}
                    title={ch.label}
                  >
                    <span className="sidebar-item-icon">{ch.icon}</span>
                    <span className="sidebar-item-label">{ch.label}</span>
                  </button>
                ))}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

export default Sidebar;
