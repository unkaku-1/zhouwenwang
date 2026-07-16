import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Info, X } from 'lucide-react';

/**
 * Mobile notice — non-intrusive, shows once.
 *
 * Replaces the previous full-screen "use a desktop" modal. The original
 * blocked mobile users entirely and made it impossible to access Settings
 * (the gear icon was inside a 256px-wide fixed sidebar that covered the
 * whole viewport on phones/tablets). The new version shows a small,
 * dismissible banner at the top of the screen for 6 seconds on first
 * visit, then never again unless the user clears localStorage.
 *
 * Resize is watched so a desktop user resizing to mobile width will not
 * re-trigger.
 */
const MobileDetector: React.FC = () => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const dismissed = localStorage.getItem('mobile-notice-dismissed');
    if (dismissed) return;

    const isSmall = () => window.innerWidth < 768;
    if (!isSmall()) return;

    // show after a short delay so the page settles first
    const t = setTimeout(() => setShow(true), 600);
    return () => clearTimeout(t);
  }, []);

  const handleDismiss = () => {
    setShow(false);
    try { localStorage.setItem('mobile-notice-dismissed', '1'); } catch {}
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.25 }}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] max-w-[92vw]"
          role="status"
        >
          <div className="flex items-center gap-2 bg-[#1a1a1a] border border-[#333333] text-[#CCCCCC] text-xs px-3 py-2 rounded-full shadow-lg">
            <Info className="w-3.5 h-3.5 text-[#FF9900] flex-shrink-0" />
            <span>小屏提示：点右上角 ⚙ 进入设置</span>
            <button
              onClick={handleDismiss}
              aria-label="关闭提示"
              className="ml-1 text-[#888888] hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default MobileDetector;