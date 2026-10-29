import { useEffect, useState } from 'react';

/**
 * 在线状态（M2「离线可用」判据用）。
 * 应用本身不发任何运行时网络请求，这里只是给用户一句提示；
 * 断网时不能白屏、不能报"网络错误"，所以状态只影响一条横幅。
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}
