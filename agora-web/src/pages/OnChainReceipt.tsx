import { CheckCircle2, ExternalLink, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { HashDisplay } from '../components/HashDisplay';
import { MerkleTree } from '../components/MerkleTree';

export function OnChainReceipt() {
  const { taskId } = useParams();
  const [isVerifying, setIsVerifying] = useState(false);
  const [isVerified, setIsVerified] = useState<boolean | null>(null);

  const handleVerify = () => {
    setIsVerifying(true);
    setTimeout(() => {
      setIsVerifying(false);
      setIsVerified(true);
    }, 1500);
  };

  return (
    <div className="max-w-[1000px] mx-auto w-full">
      
      <header className="mb-10 flex flex-col md:flex-row justify-between items-start gap-6">
        <div>
          <h1 className="text-3xl md:text-4xl mb-4">Proof of Deliberation</h1>
          <p className="text-text-secondary text-lg max-w-[600px]">
            Cryptographic verification of the complete governance process for task <span className="mono text-text-primary">{taskId}</span>.
          </p>
        </div>
        <div className="px-6 py-3 bg-accent-muted border border-accent rounded-lg flex items-center gap-3 self-start">
           <ShieldCheck size={24} className="text-accent" />
           <div>
             <div className="mono text-xs text-accent">AGORA VERIFIED</div>
             <div className="text-sm font-medium">On-Chain Record</div>
           </div>
        </div>
      </header>

      {/* STATS GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-10 w-full">
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">MECHANISM USED</div>
          <div className="text-lg font-semibold">DEBATE</div>
        </div>
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">CONSENSUS CONFIDENCE</div>
          <div className="mono text-lg font-semibold text-accent">87.3%</div>
        </div>
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">QUORUM</div>
          <div className="text-lg font-semibold text-accent flex items-center gap-2">
            <CheckCircle2 size={18} /> Reached
          </div>
        </div>
        <div className="card p-6">
           <div className="mono text-text-muted text-xs mb-2">FINAL ANSWER</div>
           <div className="text-sm line-clamp-2">"Monolithic architecture is the right choice..."</div>
        </div>
        <div className="card p-6">
           <div className="mono text-text-muted text-xs mb-2">ROUNDS</div>
           <div className="text-lg font-semibold">3 <span className="text-sm text-text-muted font-normal">(adaptive termination)</span></div>
        </div>
        <div className="card p-6">
           <div className="mono text-text-muted text-xs mb-2">TOKEN COST</div>
           <div className="mono text-lg font-semibold">4,821 <span className="text-sm text-text-muted font-normal">· $0.012</span></div>
        </div>
      </div>

      {/* ON-CHAIN DATA */}
      <h2 className="text-2xl mb-6">On-Chain Verification</h2>
      
      <div className="card p-6 mb-10 overflow-x-auto w-full">
        <table className="w-full min-w-[600px] border-collapse">
          <tbody>
            <tr className="border-b border-border-subtle">
              <td className="py-4 text-text-secondary w-[250px]">Merkle Root</td>
              <td className="py-4"><HashDisplay hash="0x7a3f8b2ee8b24c1d" /></td>
              <td className="py-4 text-right"></td>
            </tr>
            <tr className="border-b border-border-subtle">
              <td className="py-4 text-text-secondary">Receipt Transaction</td>
              <td className="py-4"><HashDisplay hash="0x9c1d4a7f4f7a2b8e" /></td>
              <td className="py-4 text-right">
                <a href="#" className="text-accent flex items-center justify-end gap-1 text-sm">
                  View Explorer <ExternalLink size={14} />
                </a>
              </td>
            </tr>
            <tr className="border-b border-border-subtle">
              <td className="py-4 text-text-secondary">Selector Reasoning Hash</td>
              <td className="py-4"><HashDisplay hash="0x2b8e1c3d7b2e9f4a" /></td>
              <td className="py-4 text-right"></td>
            </tr>
            <tr>
              <td className="py-4 text-text-secondary">Payment Status</td>
              <td colSpan={2} className="py-4">
                 <div className="mono inline-flex items-center gap-2 bg-accent-muted text-accent px-3 py-1 rounded text-sm">
                   0.01 SOL — Released <CheckCircle2 size={14} />
                 </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* MERKLE TREE */}
      <MerkleTree />

      {/* VERIFY BUTTON */}
      <div className="mt-10 flex flex-col items-center">
        <button 
          className="btn-primary w-[250px] justify-center" 
          onClick={handleVerify}
          disabled={isVerifying || isVerified === true}
        >
          {isVerifying ? 'Recomputing Root...' : 
           isVerified ? <><CheckCircle2 size={18} /> Receipt Valid</> : 
           'Verify Locally'}
        </button>
        {isVerified && (
          <p className="mono text-accent mt-4 text-sm">
             Recomputed Merkle root matches on-chain value.
          </p>
        )}
      </div>

    </div>
  );
}
