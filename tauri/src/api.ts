import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type {
  ResetOptions,
  ResetProgress,
  UserStatus,
  CreateUserResult,
  SuccessResult,
  LaunchResult,
  ResetUserResult,
  FullResetResult,
} from './types';

/**
 * Type-safe Tauri API wrapper
 */
export const tauriAPI = {
  // User management
  checkZoomUser: (): Promise<UserStatus> =>
    invoke('check_zoom_user'),

  createZoomUser: (): Promise<CreateUserResult> =>
    invoke('create_zoom_user'),

  deleteZoomUser: (): Promise<SuccessResult> =>
    invoke('delete_zoom_user'),

  launchZoomAsUser: (): Promise<LaunchResult> =>
    invoke('launch_zoom_as_user'),

  resetZoomUser: (): Promise<ResetUserResult> =>
    invoke('reset_zoom_user'),

  // Full reset
  fullReset: (options: ResetOptions): Promise<FullResetResult> =>
    invoke('full_reset', { options }),

  // App control
  quitApp: (): Promise<void> =>
    invoke('quit_app'),
};

/**
 * Listen for reset progress events
 */
export function onResetProgress(
  callback: (progress: ResetProgress) => void
): Promise<UnlistenFn> {
  return listen<ResetProgress>('reset-progress', (event) => {
    callback(event.payload);
  });
}

/**
 * Listen for general progress events
 */
export function onProgress(
  callback: (message: string) => void
): Promise<UnlistenFn> {
  return listen<string>('progress', (event) => {
    callback(event.payload);
  });
}

// Re-export types for convenience
export type {
  ResetOptions,
  ResetProgress,
  UserStatus,
  CreateUserResult,
  SuccessResult,
  LaunchResult,
  ResetUserResult,
  FullResetResult,
} from './types';
