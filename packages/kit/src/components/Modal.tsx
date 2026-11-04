import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/** Content over everything; Esc, the close button and the backdrop close it. */
export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <dialog open className="modal modal-open" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="modal-box max-w-3xl p-0">
        <div className="flex justify-end p-1">
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="Close" onClick={onClose}><X className="size-4" /></button>
        </div>
        {children}
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </dialog>
  );
}
