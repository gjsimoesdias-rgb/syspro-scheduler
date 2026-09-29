/**
 * AdvancedFilterBuilder — Workflow tab advanced filter + sort.
 * Recursive AND/OR/group query builder over Production Jobs, plus multi-level
 * sort. Edits a local draft; Apply commits to uiStore (advancedFilter/Sort).
 */
import React, { useEffect, useState } from 'react';
import { useUiStore } from '../stores/uiStore';
import {
  JOB_FILTER_FIELDS, OPERATORS_BY_TYPE, fieldDef, newRule, newGroup, countRules,
  type FilterGroup, type FilterRule, type SortSpec, type AnyOp,
} from '../lib/advancedFilter';
import './AdvancedFilterBuilder.css';

interface Props { open: boolean; onClose: () => void; }

function cloneTree<T>(t: T): T { return JSON.parse(JSON.stringify(t)); }

const RuleEditor: React.FC<{
  rule: FilterRule;
  onChange: (r: FilterRule) => void;
  onRemove: () => void;
}> = ({ rule, onChange, onRemove }) => {
  const def = fieldDef(rule.field);
  const type = def?.type ?? 'text';
  const ops = OPERATORS_BY_TYPE[type];
  const noValue = rule.operator === 'isEmpty' || rule.operator === 'isNotEmpty';
  const isBetween = rule.operator === 'between';
  const isMulti = rule.operator === 'isAnyOf' || rule.operator === 'isNoneOf';

  const changeField = (field: string) => {
    const nd = fieldDef(field);
    const firstOp = (nd ? OPERATORS_BY_TYPE[nd.type][0].value : 'contains') as AnyOp;
    onChange({ ...rule, field, operator: firstOp, value: '', value2: '', values: [] });
  };

  return (
    <div className="afb-rule">
      <select className="afb-select afb-field" value={rule.field} onChange={(e) => changeField(e.target.value)}>
        <option value="">Select field…</option>
        {JOB_FILTER_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>

      <select className="afb-select afb-op" value={rule.operator}
        onChange={(e) => onChange({ ...rule, operator: e.target.value as AnyOp })} disabled={!def}>
        {ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      {!def || noValue ? <span className="afb-value-spacer" /> : isMulti && def.type === 'enum' ? (
        <div className="afb-multiselect">
          {(def.options || []).map((opt) => {
            const checked = (rule.values || []).includes(opt);
            return (
              <label key={opt} className={`afb-chip ${checked ? 'on' : ''}`}>
                <input type="checkbox" checked={checked}
                  onChange={(e) => {
                    const set = new Set(rule.values || []);
                    if (e.target.checked) set.add(opt); else set.delete(opt);
                    onChange({ ...rule, values: Array.from(set) });
                  }} />
                {opt}
              </label>
            );
          })}
        </div>
      ) : def.type === 'enum' ? (
        <select className="afb-select afb-value" value={rule.value}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}>
          <option value="">Select…</option>
          {(def.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      ) : (
        <div className="afb-value-wrap">
          <input className="afb-input afb-value"
            type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
            value={rule.value} placeholder="value"
            onChange={(e) => onChange({ ...rule, value: e.target.value })} />
          {isBetween && (
            <>
              <span className="afb-and">and</span>
              <input className="afb-input afb-value"
                type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
                value={rule.value2 ?? ''} placeholder="value"
                onChange={(e) => onChange({ ...rule, value2: e.target.value })} />
            </>
          )}
        </div>
      )}

      <button className="afb-icon-btn afb-remove" title="Remove condition" onClick={onRemove}>✕</button>
    </div>
  );
};

const GroupEditor: React.FC<{
  group: FilterGroup;
  onChange: (g: FilterGroup) => void;
  onRemove?: () => void;
  depth: number;
}> = ({ group, onChange, onRemove, depth }) => {
  const setChild = (idx: number, child: FilterRule | FilterGroup) => {
    const children = group.children.slice(); children[idx] = child; onChange({ ...group, children });
  };
  const removeChild = (idx: number) => {
    const children = group.children.slice(); children.splice(idx, 1);
    onChange({ ...group, children: children.length ? children : [newRule()] });
  };

  return (
    <div className={`afb-group depth-${Math.min(depth, 4)}`}>
      <div className="afb-group-head">
        <div className="afb-combinator" role="group" aria-label="Match type">
          <button className={group.combinator === 'AND' ? 'on' : ''}
            onClick={() => onChange({ ...group, combinator: 'AND' })}>AND</button>
          <button className={group.combinator === 'OR' ? 'on' : ''}
            onClick={() => onChange({ ...group, combinator: 'OR' })}>OR</button>
        </div>
        <span className="afb-group-hint">
          {group.combinator === 'AND' ? 'match all of the following' : 'match any of the following'}
        </span>
        {onRemove && (
          <button className="afb-icon-btn afb-remove" title="Remove group" onClick={onRemove}>✕ group</button>
        )}
      </div>

      <div className="afb-children">
        {group.children.map((child, idx) => child.kind === 'group' ? (
          <GroupEditor key={child.id} group={child} depth={depth + 1}
            onChange={(g) => setChild(idx, g)} onRemove={() => removeChild(idx)} />
        ) : (
          <RuleEditor key={child.id} rule={child}
            onChange={(r) => setChild(idx, r)} onRemove={() => removeChild(idx)} />
        ))}
      </div>

      <div className="afb-group-actions">
        <button className="afb-add" onClick={() => onChange({ ...group, children: [...group.children, newRule()] })}>+ Condition</button>
        {depth < 3 && (
          <button className="afb-add afb-add-group" onClick={() => onChange({ ...group, children: [...group.children, newGroup(group.combinator === 'AND' ? 'OR' : 'AND')] })}>+ Group</button>
        )}
      </div>
    </div>
  );
};

const AdvancedFilterBuilder: React.FC<Props> = ({ open, onClose }) => {
  const advancedFilter = useUiStore((s) => s.advancedFilter);
  const setAdvancedFilter = useUiStore((s) => s.setAdvancedFilter);
  const advancedSort = useUiStore((s) => s.advancedSort);
  const setAdvancedSort = useUiStore((s) => s.setAdvancedSort);

  const [draft, setDraft] = useState<FilterGroup>(() => advancedFilter ? cloneTree(advancedFilter) : newGroup('AND'));
  const [sorts, setSorts] = useState<SortSpec[]>(() => cloneTree(advancedSort));

  useEffect(() => {
    if (open) {
      setDraft(advancedFilter ? cloneTree(advancedFilter) : newGroup('AND'));
      setSorts(cloneTree(advancedSort));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const ruleCount = countRules(draft);

  const apply = () => {
    setAdvancedFilter(ruleCount > 0 ? draft : null);
    setAdvancedSort(sorts.filter((s) => !!fieldDef(s.field)));
    onClose();
  };
  const clearAll = () => {
    setDraft(newGroup('AND'));
    setSorts([]);
    setAdvancedFilter(null);
    setAdvancedSort([]);
  };

  const addSort = () => setSorts([...sorts, { id: `s_${Date.now()}_${sorts.length}`, field: '', direction: 'asc' }]);
  const setSort = (idx: number, spec: SortSpec) => { const n = sorts.slice(); n[idx] = spec; setSorts(n); };
  const removeSort = (idx: number) => { const n = sorts.slice(); n.splice(idx, 1); setSorts(n); };

  return (
    <div className="afb-overlay" role="dialog" aria-modal="true" aria-label="Advanced filter" onMouseDown={onClose}>
      <div className="afb-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="afb-header">
          <h3>Advanced Filter &amp; Sort</h3>
          <button className="afb-icon-btn" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="afb-body">
          <div className="afb-section-label">Conditions</div>
          <GroupEditor group={draft} depth={0} onChange={setDraft} />

          <div className="afb-section-label afb-sort-label">Sort</div>
          <div className="afb-sorts">
            {sorts.length === 0 && <div className="afb-sort-empty">No sorting applied — jobs keep their default order.</div>}
            {sorts.map((s, idx) => (
              <div className="afb-sort-row" key={s.id}>
                <span className="afb-sort-index">{idx === 0 ? 'Sort by' : 'then by'}</span>
                <select className="afb-select" value={s.field} onChange={(e) => setSort(idx, { ...s, field: e.target.value })}>
                  <option value="">Select field…</option>
                  {JOB_FILTER_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
                <div className="afb-combinator afb-dir">
                  <button className={s.direction === 'asc' ? 'on' : ''} onClick={() => setSort(idx, { ...s, direction: 'asc' })}>Asc ↑</button>
                  <button className={s.direction === 'desc' ? 'on' : ''} onClick={() => setSort(idx, { ...s, direction: 'desc' })}>Desc ↓</button>
                </div>
                <button className="afb-icon-btn afb-remove" title="Remove sort" onClick={() => removeSort(idx)}>✕</button>
              </div>
            ))}
            <button className="afb-add" onClick={addSort}>+ Add sort level</button>
          </div>
        </div>

        <div className="afb-footer">
          <span className="afb-count">{ruleCount === 0 ? 'No active conditions' : `${ruleCount} condition${ruleCount > 1 ? 's' : ''}`}</span>
          <div className="afb-footer-actions">
            <button className="afb-btn afb-btn-ghost" onClick={clearAll}>Clear all</button>
            <button className="afb-btn afb-btn-ghost" onClick={onClose}>Cancel</button>
            <button className="afb-btn afb-btn-primary" onClick={apply}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdvancedFilterBuilder;
