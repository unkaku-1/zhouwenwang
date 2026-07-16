import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { SettingsModal } from './SettingsModal';

/**
 * Floating Action Button that opens Settings.
 *
 * Why this exists: the original project's only entry to Settings was a gear
 * icon inside a 256px-wide fixed sidebar. On small screens that sidebar
 * covers the whole viewport, so the gear is invisible. This FAB is always
 * visible, bottom-right corner, on every page. The original sidebar entry
 * is kept for users who already know where to look.
 */
const SettingsFab: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);

  // Only show the FAB when a sidebar is in some sense "hidden / hard to
  // reach" — i.e. on phones. Desktop users keep the sidebar entry; we
  // don't need to clutter the screen.
  useEffect(() => {
    const onResize = () => setVisible(window.innerWidth < 768);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!visible) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="打开设置"
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full bg-[#FF9900] hover:bg-[#E68A00] active:scale-95 text-black shadow-2xl flex items-center justify-center transition-transform"
        style={{ boxShadow: '0 8px 24px rgba(255,153,0,0.35)' }}
      >
        <SettingsIcon className="w-6 h-6" />
      </button>
      <SettingsModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default SettingsFab;