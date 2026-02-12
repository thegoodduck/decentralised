const STORAGE_KEY = 'interpoll_rate_limits';

interface RateLimitState {
  lastActionTime: number;
  currentCooldown: number;
}

interface StoredLimits {
  post?: RateLimitState;
  comment?: RateLimitState;
}

const BASE_COOLDOWNS = {
  post: 60_000,     // 1 minute
  comment: 20_000,  // 20 seconds
} as const;

function loadState(): StoredLimits {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Corrupted data
  }
  return {};
}

function saveState(state: StoredLimits) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export class RateLimitService {
  /**
   * Check how many milliseconds remain before the next action is allowed.
   * Returns 0 if the action is allowed now.
   */
  static getRemainingCooldown(type: 'post' | 'comment'): number {
    const state = loadState()[type];
    if (!state) return 0;

    const elapsed = Date.now() - state.lastActionTime;
    const remaining = state.currentCooldown - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Check if an action is allowed right now.
   */
  static canPerformAction(type: 'post' | 'comment'): boolean {
    return this.getRemainingCooldown(type) === 0;
  }

  /**
   * Record that an action was performed. Updates the cooldown:
   * - If performing within the previous cooldown window, doubles the cooldown.
   * - Otherwise resets to the base cooldown.
   */
  static recordAction(type: 'post' | 'comment') {
    const limits = loadState();
    const previous = limits[type];
    const baseCooldown = BASE_COOLDOWNS[type];
    const now = Date.now();

    let newCooldown = baseCooldown;

    if (previous) {
      const elapsed = now - previous.lastActionTime;
      // If the previous cooldown hadn't fully expired yet (action performed
      // right after cooldown ended but within the doubling window),
      // or if less than 2x the current cooldown has passed, double it.
      if (elapsed < previous.currentCooldown * 2) {
        newCooldown = Math.min(previous.currentCooldown * 2, 30 * 60_000); // cap at 30 min
      }
    }

    limits[type] = {
      lastActionTime: now,
      currentCooldown: newCooldown,
    };

    saveState(limits);
  }

  /**
   * Format remaining milliseconds to a human-readable string.
   */
  static formatRemaining(ms: number): string {
    if (ms <= 0) return '0s';
    const totalSeconds = Math.ceil(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (seconds === 0) return `${minutes}m`;
    return `${minutes}m ${seconds}s`;
  }
}
