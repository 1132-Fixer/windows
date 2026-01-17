/**
 * Step Handlers Index
 *
 * Exports all step handlers and provides a factory for creating
 * the complete handler registry.
 */

import type { StepHandler } from '../types';
import type { SystemAdapter } from '../adapters/system-adapter';
import { createStopProcessHandler } from './stop-process';
import { createStopServiceHandler } from './stop-service';
import { createRemoveFolderHandler } from './remove-folder';
import { createDeleteRegistryKeyHandler } from './delete-registry-key';
import { createDeleteScheduledTaskHandler } from './delete-scheduled-task';

export { createStopProcessHandler } from './stop-process';
export { createStopServiceHandler } from './stop-service';
export { createRemoveFolderHandler } from './remove-folder';
export { createDeleteRegistryKeyHandler } from './delete-registry-key';
export { createDeleteScheduledTaskHandler } from './delete-scheduled-task';

/**
 * Step handler registry type
 */
export type StepHandlerRegistry = Map<string, StepHandler>;

/**
 * Create a complete registry of all step handlers
 */
export function createStepHandlerRegistry(system: SystemAdapter): StepHandlerRegistry {
  const registry = new Map<string, StepHandler>();

  const handlers = [
    createStopProcessHandler(system),
    createStopServiceHandler(system),
    createRemoveFolderHandler(system),
    createDeleteRegistryKeyHandler(system),
    createDeleteScheduledTaskHandler(system),
  ];

  for (const handler of handlers) {
    registry.set(handler.action, handler);
  }

  return registry;
}

/**
 * Get a handler for a specific action
 */
export function getHandler(
  registry: StepHandlerRegistry,
  action: string,
): StepHandler | undefined {
  return registry.get(action);
}
