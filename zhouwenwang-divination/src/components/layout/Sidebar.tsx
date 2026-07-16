import React, { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Home,
  Settings,
  ChevronLeft,
  ChevronRight,
  Star,
  Menu,
  X
} from 'lucide-react';
import { getAllGames } from '../../games';
import { useSettings, useUI } from '../../core/store';
import { SettingsModal } from '../common/SettingsModal';
import { preloadComponent, preloadAllGames } from '../../utils/preload';

interface SidebarProps {
  className?: string;
}

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  isCollapsed: boolean;
  isActive: boolean;
  preloadKey?: string;
  onNavigate?: () => void;
}

interface SettingsItemProps {
  icon: React.ReactNode;
  label: string;
  isCollapsed: boolean;
  isActive: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ to, icon, label, isCollapsed, isActive, preloadKey, onNavigate }) => {
  const { clearError } = useUI();
  const linkRef = useRef<HTMLAnchorElement>(null);

  // 在鼠标悬停时预加载组件
  useEffect(() => {
    if (preloadKey && linkRef.current) {
      const handleMouseEnter = () => {
        preloadComponent(preloadKey as any);
      };
      const element = linkRef.current;
      element.addEventListener('mouseenter', handleMouseEnter, { once: true });
      return () => {
        element.removeEventListener('mouseenter', handleMouseEnter);
      };
    }
  }, [preloadKey]);

  return (
    <Link
      ref={linkRef}
      to={to}
      onClick={() => {
        clearError();
        onNavigate?.();
      }}
      className={`
        flex items-center px-5 py-4 rounded-xl transition-all duration-300 ease-in-out
        font-medium text-base min-h-[52px] mb-2 text-white
        ${isActive
          ? 'bg-[#2a2a2a] text-white shadow-md'
          : 'hover:bg-[#1a1a1a] hover:text-white hover:shadow-sm'
        }
        ${isCollapsed ? 'justify-center px-3' : 'justify-start'}
      `}
      style={{ margin: isCollapsed ? '0.5rem' : '1rem' }}
      title={isCollapsed ? label : undefined}
    >
      <motion.span
        className="flex-shrink-0 flex items-center justify-center w-5 h-5"
        style={{ margin: '1rem' }}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        transition={{ duration: 0.2 }}
      >
        {icon}
      </motion.span>
      <AnimatePresence>
        {!isCollapsed && (
          <motion.span
            className="font-medium whitespace-nowrap ml-3 flex items-center"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: "auto" }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.3 }}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </Link>
  );
};

const SettingsItem: React.FC<SettingsItemProps> = ({ icon, label, isCollapsed, isActive, onClick }) => {
  const { clearError } = useUI();

  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        clearError();
        onClick();
      }}
      className={`
        flex items-center px-5 py-4 rounded-xl transition-all duration-300 ease-in-out
        font-medium text-base min-h-[52px] mb-2 text-white cursor-pointer
        ${isActive
          ? 'bg-[#2a2a2a] text-white shadow-md'
          : 'hover:bg-[#1a1a1a] hover:text-white hover:shadow-sm'
        }
        ${isCollapsed ? 'justify-center px-3' : 'justify-start'}
      `}
      style={{ margin: isCollapsed ? '0.5rem' : '1rem' }}
      title={isCollapsed ? label : undefined}
    >
      <motion.span
        className="flex-shrink-0 flex items-center justify-center w-5 h-5"
        style={{ margin: '1rem' }}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        transition={{ duration: 0.2 }}
      >
        {icon}
      </motion.span>
      <AnimatePresence>
        {!isCollapsed && (
          <motion.span
            className="font-medium whitespace-nowrap ml-3 flex items-center"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: "auto" }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.3 }}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </a>
  );
};

/**
 * Responsive sidebar:
 *
 *  - Desktop (>= 1024px):  fixed 256px (or 80px when collapsed), inline toggle
 *  - Tablet  (768–1023px): fixed 80px icon-only, "expand on hover" behavior
 *  - Mobile  (< 768px):    hidden; top-bar hamburger opens a slide-in drawer
 *                          with a dark scrim; tapping a nav item or the scrim
 *                          closes it.
 *
 * The mobile hamburger lives in a top bar rendered outside the sidebar so
 * it's always visible regardless of the sidebar's own state.
 */
const Sidebar: React.FC<SidebarProps> = ({ className }) => {
  const location = useLocation();
  const games = getAllGames();
  const { settings, toggleSidebar } = useSettings();
  const { clearError } = useUI();
  const isCollapsed = settings.sidebarCollapsed;

  // 设置弹窗状态
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  // Mobile drawer state
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  // Track viewport so we can render the right shape and reset drawer on
  // resize up to desktop.
  const [isMobile, setIsMobile] = useState<boolean>(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  const [isTablet, setIsTablet] = useState<boolean>(
    typeof window !== 'undefined'
      ? window.innerWidth >= 768 && window.innerWidth < 1024
      : false
  );

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      setIsMobile(w < 768);
      setIsTablet(w >= 768 && w < 1024);
      if (w >= 768) setIsMobileOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 路径到预加载键的映射
  const getPreloadKey = (path: string) => {
    const pathMap: Record<string, string> = {
      '/liuyao': 'liuyao',
      '/qimen': 'qimen',
      '/bazi': 'bazi',
      '/palmistry': 'palmistry',
      '/zhougong': 'zhougong',
      '/masters': 'masters'
    };
    return pathMap[path];
  };

  // 构建导航项：首页 + 动态游戏列表
  const navItems = [
    { to: '/', icon: <Home size={20} />, label: '首页', preloadKey: undefined },
    ...games.map(game => ({
      to: game.path,
      icon: game.icon ? <game.icon size={20} /> : <Home size={20} />,
      label: game.name,
      preloadKey: getPreloadKey(game.path)
    }))
  ];

  useEffect(() => {
    const timer = setTimeout(() => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => {
          preloadAllGames();
        });
      } else {
        setTimeout(() => {
          preloadAllGames();
        }, 100);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // close mobile drawer on route change
  useEffect(() => {
    setIsMobileOpen(false);
  }, [location.pathname]);

  // Tablet auto-collapse behavior: when in tablet range, ignore persisted
  // sidebarCollapsed and force icon-only.
  const effectiveCollapsed = isTablet ? true : isCollapsed;

  return (
    <>
      {/* MOBILE TOP BAR — only on small screens */}
      {isMobile && (
        <div
          className="fixed top-0 left-0 right-0 h-14 bg-black border-b border-[#333333] z-50 flex items-center px-3"
          role="banner"
        >
          <button
            onClick={() => setIsMobileOpen(true)}
            aria-label="打开菜单"
            className="p-2 rounded-lg text-white hover:bg-[#333333] active:bg-[#444444] transition-colors"
          >
            <Menu size={22} />
          </button>
          <div className="ml-3 flex items-center gap-2 text-white">
            <Star className="w-4 h-4 text-[#FF9900]" />
            <span className="text-sm font-medium">AI占卜</span>
          </div>
        </div>
      )}

      {/* MOBILE BACKDROP */}
      <AnimatePresence>
        {isMobile && isMobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setIsMobileOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* SIDEBAR */}
      <motion.div
        className={`
          bg-black border-r border-[#333333] flex flex-col z-50
          ${isMobile ? 'fixed left-0 top-0 h-screen' : 'fixed left-0 top-0 h-screen'}
          ${className || ''}
        `}
        style={{
          width: isMobile ? '280px' : (effectiveCollapsed ? '80px' : '256px')
        }}
        initial={false}
        animate={{
          x: isMobile ? (isMobileOpen ? 0 : -300) : 0
        }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
      >
        {/* Header */}
        <div className={`p-4 border-b border-[#333333] flex items-center ${effectiveCollapsed && !isMobile ? 'justify-center' : 'justify-between'}`}>
          <AnimatePresence>
            {(!effectiveCollapsed || isMobile) && (
              <motion.div
                className="flex items-center gap-2"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                style={{ marginTop: '1rem', marginBottom: '1rem', marginLeft: '1.5rem', marginRight: '1rem' }}
              >
                <Star className="w-5 h-5 text-[#FF9900]" style={{ marginRight: '1rem' }} />
                <h1 className="text-white font-medium" style={{ fontSize: '22px' }}>
                  AI占卜
                </h1>
              </motion.div>
            )}
          </AnimatePresence>
          {isMobile ? (
            <button
              onClick={() => setIsMobileOpen(false)}
              aria-label="关闭菜单"
              className="p-2 rounded-lg text-[#CCCCCC] hover:bg-[#333333] hover:text-white transition-colors"
              style={{ margin: '0.5rem' }}
            >
              <X size={20} />
            </button>
          ) : (
            <motion.button
              onClick={toggleSidebar}
              className="p-2 rounded-lg text-[#CCCCCC] hover:bg-[#333333] hover:text-white transition-colors"
              style={{ margin: isCollapsed ? '0.5rem' : '1rem' }}
              aria-label={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              transition={{ duration: 0.2 }}
            >
              <motion.div
                animate={{ rotate: isCollapsed ? 0 : 180 }}
                transition={{ duration: 0.3 }}
              >
                {isCollapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
              </motion.div>
            </motion.button>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 overflow-y-auto">
          {navItems.map((item, index) => (
            <motion.div
              key={item.to}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: index * 0.05 }}
            >
              <NavItem
                to={item.to}
                icon={item.icon}
                label={item.label}
                isCollapsed={effectiveCollapsed && !isMobile}
                isActive={location.pathname === item.to}
                preloadKey={item.preloadKey}
                onNavigate={() => isMobile && setIsMobileOpen(false)}
              />
            </motion.div>
          ))}
        </nav>

        {/* 设置按钮 - 固定在底部 */}
        <div className="mt-auto">
          <motion.div
            className="p-4 border-t border-[#333333] bg-black"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.25 }}
          >
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
            >
              <SettingsItem
                icon={<Settings size={20} />}
                label="设置"
                isCollapsed={effectiveCollapsed && !isMobile}
                isActive={isSettingsModalOpen}
                onClick={() => {
                  setIsSettingsModalOpen(true);
                  if (isMobile) setIsMobileOpen(false);
                }}
              />
            </motion.div>
          </motion.div>
        </div>
      </motion.div>

      {/* 设置模态框 */}
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
      />
    </>
  );
};

export default Sidebar;