import { useCallback, useEffect, useState } from 'react';

export const useZoom = () => {
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [startPosition, setStartPosition] = useState({ x: 0, y: 0 });

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((prevScale) =>
      Math.min(Math.max(prevScale - e.deltaY * 0.01, 1), 3)
    );
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(
        touch1.clientX - touch2.clientX,
        touch1.clientY - touch2.clientY
      );
      setStartPosition({ x: distance, y: 0 });
    } else if (e.touches.length === 1) {
      setPanning(true);
      setStartPosition({ x: e.touches[0].clientX, y: e.touches[0].clientY });
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const distance = Math.hypot(
          touch1.clientX - touch2.clientX,
          touch1.clientY - touch2.clientY
        );
        const newScale = scale * (distance / startPosition.x);
        setScale(Math.min(Math.max(newScale, 1), 3));
      } else if (e.touches.length === 1 && panning) {
        const deltaX = e.touches[0].clientX - startPosition.x;
        const deltaY = e.touches[0].clientY - startPosition.y;
        setPosition((prev) => ({ x: prev.x + deltaX, y: prev.y + deltaY }));
        setStartPosition({ x: e.touches[0].clientX, y: e.touches[0].clientY });
      }
    },
    [scale, startPosition, panning]
  );

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    setPanning(false);
  }, []);

  useEffect(() => {
    // Set viewport to prevent zooming when modal is open
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
      viewport.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'
      );
    }

    const preventDefault = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        e.preventDefault();
      }
    };

    document.addEventListener('gesturestart', preventDefault as EventListener);
    document.addEventListener('gesturechange', preventDefault as EventListener);
    document.addEventListener('gestureend', preventDefault as EventListener);
    document.addEventListener('touchstart', preventDefault, { passive: false });

    // Cleanup function
    return () => {
      document.removeEventListener(
        'gesturestart',
        preventDefault as EventListener
      );
      document.removeEventListener(
        'gesturechange',
        preventDefault as EventListener
      );
      document.removeEventListener(
        'gestureend',
        preventDefault as EventListener
      );
      document.removeEventListener(
        'touchstart',
        preventDefault as EventListener
      );

      // Reset viewport when modal closes
      if (viewport) {
        viewport.setAttribute('content', 'width=device-width, initial-scale=1');
      }
    };
  }, []); // Only run on mount and cleanup

  const blockScroll = useCallback(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'auto';
    };
  }, []);

  return {
    scale,
    position,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    blockScroll,
  };
};
