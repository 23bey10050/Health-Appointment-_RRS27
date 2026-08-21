import { useEffect, useState } from 'react';

/**
 * True only once `isLoading` has stayed true for longer than `delayMs`. A request that resolves
 * in 200ms should never flash a loading state at all - the flash itself is what makes an app feel
 * unsteady. This is also the one piece of UI that turns a genuine Render free-tier cold start into
 * something that reads as the system talking to the visitor instead of the system being broken:
 * fast requests stay silent, and only a request that is actually taking a while gets explained.
 */
export function useDelayedLoading(isLoading: boolean, delayMs = 1200): boolean {
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      return undefined;
    }
    const timer = setTimeout(() => setShowLoading(true), delayMs);
    // Runs the moment `isLoading` goes back to false (or the component unmounts) - hiding the
    // notice again is "undo what this effect did", which is exactly what a cleanup function is
    // for, rather than a second setState call sitting directly in the effect body itself.
    return () => {
      clearTimeout(timer);
      setShowLoading(false);
    };
  }, [isLoading, delayMs]);

  return showLoading;
}
