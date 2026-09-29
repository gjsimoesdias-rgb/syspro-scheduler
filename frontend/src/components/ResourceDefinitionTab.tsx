import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { resourceService } from '../services/api';
import './ResourceDefinitionTab.css';

type ShiftTemplate = {
  shiftId: string;
  name: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
  hoursPerDay: number;
};

type ResourceDefinition = {
  resourceId: string;
  machine: string;
  workcentreId: string;
  description: string;
  quantity: number;
  shiftId: string;
  activated: boolean;
  loadingResourcePct: number;
  lineGroupId?: string;
};

const weekdaysLabel = (days: number[]) => {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days.map((d) => names[d]).join(', ');
};

type ResourceDefinitionTabProps = {
  onDefinitionsChanged?: () => void | Promise<void>;
};

const ResourceDefinitionTab: React.FC<ResourceDefinitionTabProps> = ({ onDefinitionsChanged }) => {
  const [definitions, setDefinitions] = useState<ResourceDefinition[]>([]);
  const [shifts, setShifts] = useState<ShiftTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const response = await resourceService.getDefinitions();
      setDefinitions(response.definitions as ResourceDefinition[]);
      setShifts(response.shifts as ShiftTemplate[]);
      if (response.warning) toast(response.warning);
    } catch (error: any) {
      toast.error(error.message || 'Failed to load resource definitions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const setQuantity = (resourceId: string, quantity: number) => {
    setDefinitions((prev) =>
      prev.map((d) => (d.resourceId === resourceId ? { ...d, quantity } : d))
    );
  };

  const setShift = (resourceId: string, shiftId: string) => {
    setDefinitions((prev) =>
      prev.map((d) => (d.resourceId === resourceId ? { ...d, shiftId } : d))
    );
  };

  const setLineGroup = (resourceId: string, lineGroupId: string) => {
    setDefinitions((prev) =>
      prev.map((d) => (d.resourceId === resourceId ? { ...d, lineGroupId } : d))
    );
  };

  const saveDefinition = async (definition: ResourceDefinition) => {
    try {
      setSavingId(definition.resourceId);
      const updated = await resourceService.updateDefinition(definition.resourceId, {
        quantity: definition.quantity,
        shiftId: definition.shiftId,
        activated: definition.activated,
        lineGroupId: definition.lineGroupId,
      });
      setDefinitions((prev) =>
        prev.map((d) => (d.resourceId === definition.resourceId ? (updated as ResourceDefinition) : d))
      );
      if (onDefinitionsChanged) {
        await onDefinitionsChanged();
      }
      toast.success(`Saved ${definition.resourceId}`);
    } catch (error: any) {
      toast.error(error.message || `Failed to save ${definition.resourceId}`);
    } finally {
      setSavingId(null);
    }
  };


  return (
    <div className="resource-def-tab">
      <div className="resource-def-toolbar">
        <h3>Resource Definition</h3>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>


      <div className="resource-def-grid-wrapper">
        <table className="resource-def-grid">
          <thead>
            <tr>
              <th>Work Center</th>
              <th>Machine</th>
              <th>Description</th>
              <th>Resources</th>
              <th>Shift</th>
              <th>Shift Details</th>
              <th>Line Group</th>
              <th>Activated</th>
              <th>Loading (%)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {definitions.map((definition) => {
              const shift = shifts.find((s) => s.shiftId === definition.shiftId);
              return (
                <tr key={definition.resourceId}>
                  <td>{definition.workcentreId}</td>
                  <td>{definition.machine}</td>
                  <td>{definition.description}</td>
                  <td>
                    <input
                      className="qty-input"
                      type="number"
                      min={1}
                      value={definition.quantity}
                      onChange={(e) => setQuantity(definition.resourceId, Number(e.target.value || 1))}
                    />
                  </td>
                  <td>
                    <select
                      value={definition.shiftId}
                      onChange={(e) => setShift(definition.resourceId, e.target.value)}
                    >
                      {shifts.map((s) => (
                        <option key={s.shiftId} value={s.shiftId}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {shift ? `${shift.hoursPerDay}h/day (${weekdaysLabel(shift.workingDays)})` : '-'}
                  </td>
                  <td>
                    <input
                      className="line-group-input"
                      type="text"
                      placeholder="e.g. Line-A"
                      value={definition.lineGroupId ?? ''}
                      onChange={(e) => setLineGroup(definition.resourceId, e.target.value)}
                    />
                  </td>
                  <td>
                    <input type="checkbox" checked={definition.activated} readOnly />
                  </td>
                  <td>{definition.loadingResourcePct.toFixed(2)}</td>
                  <td>
                    <button
                      className="btn btn-sm"
                      onClick={() => saveDefinition(definition)}
                      disabled={savingId === definition.resourceId}
                    >
                      {savingId === definition.resourceId ? 'Saving...' : 'Save'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ResourceDefinitionTab;
