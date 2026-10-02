import React, { useState } from 'react';
import { ConstraintViolation } from '../types';
import './ConstraintOverrideModal.css';
import { AlertTriangle } from 'lucide-react';
import { alertDialog } from './DialogHost';

interface ConstraintOverrideModalProps {
  violation: ConstraintViolation | null;
  isOpen: boolean;
  onClose: () => void;
  onApprove: (violationId: string, reason: string) => void;
}

const ConstraintOverrideModal: React.FC<ConstraintOverrideModalProps> = ({
  violation,
  isOpen,
  onClose,
  onApprove
}) => {
  const [overrideReason, setOverrideReason] = useState<string>('');
  const [approverName, setApproverName] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen || !violation) return null;

  const handleSubmit = async () => {
    if (!overrideReason.trim() || !approverName.trim()) {
      await alertDialog({ title: 'Missing details', message: 'Please fill in your name and the reason for the override.' });
      return;
    }

    setIsSubmitting(true);
    try {
      const reason = `Override by ${approverName}: ${overrideReason}`;
      await onApprove(violation.violationId, reason);
      setOverrideReason('');
      setApproverName('');
      onClose();
    } catch (error) {
      console.error('Failed to approve override:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="constraint-override-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="constraint-override-title">Override Constraint</h3>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="violation-info">
            <div className="info-row">
              <label>Violation Type:</label>
              <strong>{violation.type}</strong>
            </div>
            <div className="info-row">
              <label>Severity:</label>
              <span className={`severity ${violation.severity.toLowerCase()}`}>
                {violation.severity}
              </span>
            </div>
            <div className="info-row">
              <label>Affected Job:</label>
              <strong>{violation.affectedJobId}</strong>
            </div>
            <div className="info-row full-width">
              <label>Description:</label>
              <p>{violation.description}</p>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="approver-name">
              Approver Name <span className="required">*</span>
            </label>
            <input
              id="approver-name"
              type="text"
              placeholder="Your name"
              value={approverName}
              onChange={(e) => setApproverName(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <div className="form-group">
            <label htmlFor="override-reason">
              Override Reason <span className="required">*</span>
            </label>
            <textarea
              id="override-reason"
              placeholder="Explain why this constraint violation is acceptable..."
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              rows={4}
              disabled={isSubmitting}
            />
          </div>

          <div className="warning-box">
            <strong><AlertTriangle size={13} className="ui-icon" aria-hidden="true" /> Warning:</strong> This action will override a constraint and may negatively impact
            schedule quality. Ensure proper authorization before proceeding.
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button className="btn-approve" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? 'Approving...' : '✓ Approve Override'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConstraintOverrideModal;
