import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { DEFAULT_NODE, START, cliAgent, nodeProblem, type AgentChoice } from './agent';

/** This browser's settings: who makes lessons with the teacher. */
export function Settings({ choice, onSave, onClose }: { choice: AgentChoice; onSave: (c: AgentChoice) => void; onClose: () => void }) {
  const [agent, setAgent] = useState(choice.agent);
  const [node, setNode] = useState(choice.node);
  const problem = agent === 'cli' ? nodeProblem(node.trim()) : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    onSave({ agent, node: node.trim().replace(/\/+$/, '') });
  };
  return (
    <dialog open className="modal modal-open" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form onSubmit={submit} className="modal-box flex max-w-lg flex-col gap-3 text-sm">
        <div className="flex items-center">
          <h2 className="flex-1 text-base font-semibold">Settings</h2>
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="Close" onClick={onClose}><X className="size-4" /></button>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">Who makes lessons with you</legend>
          <label className="flex items-start gap-2">
            <input type="radio" className="radio radio-sm mt-0.5" name="agent" checked={agent === 'server'} onChange={() => setAgent('server')} />
            <span>Claude, on this site<span className="block text-xs text-base-content/60">Within your school’s monthly budget.</span></span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" className="radio radio-sm mt-0.5" name="agent" checked={agent === 'cli'} onChange={() => setAgent('cli')} />
            <span>Claude Code on this computer<span className="block text-xs text-base-content/60">The <code>claude</code> command you’re signed in to here, on your own plan, through a local node.</span></span>
          </label>
        </fieldset>
        {agent === 'cli' && <Node node={node} setNode={setNode} problem={problem} />}
        <div className="modal-action mt-1">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={Boolean(problem)}>Save</button>
        </div>
      </form>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </dialog>
  );
}

function Node({ node, setNode, problem }: { node: string; setNode: (s: string) => void; problem?: string }) {
  const url = node.trim();
  // asked again a moment after the address changes, and on "Check"; an answer counts for the question it answers
  const [asked, setAsked] = useState(0);
  const question = `${asked} ${url}`;
  const [answer, setAnswer] = useState<{ question: string; status: true | string }>();
  const status = answer?.question === question ? answer.status : undefined;
  useEffect(() => {
    if (problem) return;
    let live = true;
    const t = setTimeout(() => { void cliAgent(url).available().then((a) => { if (live) setAnswer({ question, status: a }); }); }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [url, problem, question]);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return (
    <div className="flex flex-col gap-2 rounded-box bg-base-200 p-3">
      <label className="flex flex-col gap-1">The node’s address
        <div className="flex gap-1">
          <input className="input input-sm min-w-0 flex-1 font-mono" type="url" value={node} placeholder={DEFAULT_NODE} onChange={(e) => setNode(e.target.value)} />
          <button type="button" className="btn btn-sm" onClick={() => setAsked((n) => n + 1)}>Check</button>
        </div>
      </label>
      {problem && <p className="text-xs text-error">{problem}</p>}
      {!problem && status === undefined && <p className="text-xs text-base-content/60"><span className="loading loading-spinner loading-xs" /> Asking the node…</p>}
      {status === true && <p className="text-xs text-success">The node is there and runs the agent.</p>}
      {typeof status === 'string' && <p role="status" className="text-xs text-warning">{status}</p>}
      <p className="text-xs text-base-content/70">
        Start it in a checkout of the gestalts repo, with the <code>claude</code> CLI installed and signed in:
      </p>
      <code className="block overflow-x-auto whitespace-pre rounded bg-base-100 p-2 text-xs">{local ? START : `TEACHER_AGENT_ORIGIN=${location.origin} ${START}`}</code>
      {!local && <p className="text-xs text-base-content/60">Your browser may ask once whether this site may use apps on this device.</p>}
    </div>
  );
}
