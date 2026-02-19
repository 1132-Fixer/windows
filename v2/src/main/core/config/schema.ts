/**
 * Product Definition Schema
 * Validates product YAML/JSON configuration files
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas for Product Definition
// ============================================================================

export const PathsSchema = z.object({
  install: z.array(z.string()).describe('Installation directories'),
  appData: z.array(z.string()).describe('User AppData directories'),
  programData: z.array(z.string()).describe('System ProgramData directories'),
  logs: z.array(z.string()).default([]).describe('Log directories'),
  temp: z.array(z.string()).default([]).describe('Temp directories'),
});

export const RegistrySchema = z.object({
  software: z.array(z.string()).describe('Software registry keys'),
  uninstall: z.array(z.string()).default([]).describe('Uninstall registry entries'),
  services: z.array(z.string()).default([]).describe('Service registry keys'),
  other: z.array(z.string()).default([]).describe('Other registry keys'),
});

export const UninstallerSchema = z.object({
  path: z.string().describe('Path to uninstaller executable'),
  args: z.array(z.string()).default([]).describe('Uninstaller arguments'),
  msiProductCode: z.string().optional().describe('MSI product code for WMI uninstall'),
}).optional();

export const InstallerSchema = z.object({
  downloadUrl: z.string().url().describe('Download URL for installer'),
  filename: z.string().describe('Installer filename'),
  silentArgs: z.array(z.string()).default([]).describe('Silent install arguments'),
}).optional();

export const ProductDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).describe('Product identifier (lowercase, alphanumeric)'),
  vendor: z.string().describe('Vendor name'),
  displayName: z.string().describe('Human-readable product name'),
  version: z.string().optional().describe('Product version (if specific)'),

  paths: PathsSchema,
  registry: RegistrySchema,

  processes: z.array(z.string()).describe('Process names to stop'),
  services: z.array(z.string()).default([]).describe('Service names'),
  tasks: z.array(z.string()).default([]).describe('Scheduled task paths'),

  uninstaller: UninstallerSchema,
  installer: InstallerSchema,

  preservableSettings: z.array(z.string()).default([]).describe('Settings that can be preserved'),
});

export type ProductDefinitionInput = z.input<typeof ProductDefinitionSchema>;
export type ProductDefinition = z.output<typeof ProductDefinitionSchema>;

// ============================================================================
// Validation Functions
// ============================================================================

export function validateProductDefinition(input: unknown): ProductDefinition {
  return ProductDefinitionSchema.parse(input);
}

export function safeValidateProductDefinition(
  input: unknown,
): { success: true; data: ProductDefinition } | { success: false; error: z.ZodError } {
  const result = ProductDefinitionSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ============================================================================
// Product Loader
// ============================================================================

export interface ProductLoader {
  /**
   * Load a product definition by ID
   */
  load(productId: string): Promise<ProductDefinition>;

  /**
   * List available product IDs
   */
  listProducts(): Promise<string[]>;

  /**
   * Check if a product exists
   */
  exists(productId: string): Promise<boolean>;
}
