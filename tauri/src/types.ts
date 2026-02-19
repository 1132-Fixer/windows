/** Reset options passed to full_reset command */
export interface ResetOptions {
  uninstall: boolean;
  reinstall: boolean;
}

/** Individual step in reset progress */
export interface ResetStep {
  step: string;
  status: 'pending' | 'running' | 'done' | 'skipped';
  progress?: number;
}

/** Reset progress event payload */
export interface ResetProgress {
  steps: ResetStep[];
  currentStep: number;
  complete?: boolean;
}

/** User status response */
export interface UserStatus {
  exists: boolean;
  sid: string | null;
  profilePath: string | null;
}

/** Create user response */
export interface CreateUserResult {
  success: boolean;
  junctions?: string[];
  profilePath?: string;
  error?: string;
}

/** Generic success result */
export interface SuccessResult {
  success: boolean;
  error?: string;
}

/** Launch result */
export interface LaunchResult {
  success: boolean;
  zoomPath?: string;
  error?: string;
}

/** Reset user result */
export interface ResetUserResult {
  success: boolean;
  steps?: string[];
  error?: string;
}

/** Full reset result */
export interface FullResetResult {
  success: boolean;
  message: string;
  steps: string[];
  error?: string;
}

/** Download progress */
export interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
}
