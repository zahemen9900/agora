import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";

interface QuorumOverlayProps {
  finalAnswer: { text: string; confidence: number; mechanism: string } | null;
  taskId: string | undefined;
}

export function QuorumOverlay({ finalAnswer, taskId }: QuorumOverlayProps) {
  const navigate = useNavigate();

  const goToReceipt = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (taskId) {
      console.log("Navigating to receipt for task:", taskId);
      navigate(`/task/${taskId}/receipt`);
    } else {
      console.warn("No taskId provided to QuorumOverlay");
    }
  };

  return (
    <AnimatePresence>
      {finalAnswer && (
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 40 }}
          transition={{ type: "spring", damping: 24, stiffness: 220 }}
          style={{
            position: "absolute",
            bottom: 0, left: 0, right: 0,
            padding: "16px 24px",
            // Theme aware background: dark green in dark mode, light mint in light mode
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            borderTop: "2px solid #34d399",
            borderBottom: "none",
            borderRadius: "20px 20px 0 0",
            display: "flex",
            alignItems: "center",
            gap: "16px",
            zIndex: 40,
            boxShadow: "0 -8px 30px rgba(0,0,0,0.12)",
            backdropFilter: "blur(10px)",
          }}
        >
          <div style={{ 
            flexShrink: 0, 
            width: "36px", 
            height: "36px", 
            borderRadius: "50%", 
            background: "rgba(52,211,153,0.15)", 
            border: "1.5px solid #34d399", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center" 
          }}>
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
              <path d="M2 7l3.5 3.5L12 3" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ 
              fontFamily: "'Commit Mono', monospace", 
              fontSize: "10px", 
              color: "#10b981", 
              fontWeight: 600,
              letterSpacing: "0.1em", 
              marginBottom: "3px" 
            }}>
              QUORUM REACHED · {(finalAnswer.confidence * 100).toFixed(1)}% confidence
            </div>
            <div style={{ 
              fontSize: "13.5px", 
              color: "var(--text-primary)", 
              fontWeight: 500,
              overflow: "hidden", 
              textOverflow: "ellipsis", 
              whiteSpace: "nowrap" 
            }}>
              {finalAnswer.text}
            </div>
          </div>

          <button
            onClick={goToReceipt}
            data-no-drag
            style={{ 
              flexShrink: 0, 
              padding: "10px 20px", 
              borderRadius: "10px", 
              background: "#34d399", 
              color: "#052e16", 
              border: "none", 
              cursor: "pointer", 
              fontFamily: "'Commit Mono', monospace", 
              fontSize: "11px", 
              fontWeight: 700, 
              letterSpacing: "0.04em", 
              whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(52,211,153,0.3)",
              transition: "transform 0.1s ease, box-shadow 0.1s ease",
            }}
            onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.96)")}
            onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
          >
            View Receipt →
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
