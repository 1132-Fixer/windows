/**
 * 1132 Remover - Services & Scheduled Tasks
 * Removes Zoom Windows services and scheduled tasks
 */

const { spawnSafe, runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_SERVICES, ZOOM_SCHEDULED_TASKS } = require('../../shared/constants');

/**
 * Stop a Windows service
 * @param {string} serviceName - Service name
 * @returns {Promise<{success: boolean}>}
 */
async function stopService(serviceName) {
  try {
    // Try net stop first (handles spaces in names)
    await spawnSafe('net', ['stop', serviceName], { timeout: 30000 });
    return { success: true, method: 'net' };
  } catch (e) {
    // Ignore - service might not exist or already stopped
  }

  try {
    // Try sc stop
    await spawnSafe('sc', ['stop', serviceName], { timeout: 15000 });
    return { success: true, method: 'sc' };
  } catch (e) {
    // Ignore
  }

  try {
    // Try PowerShell
    await runPowerShell(`Stop-Service -Name "${serviceName}" -Force -ErrorAction SilentlyContinue`, {
      timeout: 15000
    });
    return { success: true, method: 'powershell' };
  } catch (e) {
    // Service likely doesn't exist
  }

  return { success: false };
}

/**
 * Delete a Windows service
 * @param {string} serviceName - Service name
 * @returns {Promise<{success: boolean, existed: boolean}>}
 */
async function deleteService(serviceName) {
  // Check if service exists
  try {
    const result = await runPowerShell(
      `Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name`,
      { timeout: 10000 }
    );

    if (!result.stdout || !result.stdout.trim()) {
      return { success: true, existed: false };
    }
  } catch (e) {
    return { success: true, existed: false };
  }

  // Stop the service first
  await stopService(serviceName);

  // Delete the service
  try {
    await spawnSafe('sc', ['delete', serviceName], { timeout: 15000 });

    // Verify deletion
    const checkResult = await runPowerShell(
      `Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue`,
      { timeout: 5000 }
    );

    const deleted = !checkResult.stdout || !checkResult.stdout.trim();
    return { success: deleted, existed: true, deleted };
  } catch (e) {
    return { success: false, existed: true, error: e.message };
  }
}

/**
 * Remove all Zoom services
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, deleted: number, failed: number}>}
 */
async function removeAllZoomServices(onProgress = null) {
  logger.section('Removing Zoom Services');

  let deleted = 0;
  let failed = 0;
  const results = [];

  for (let i = 0; i < ZOOM_SERVICES.length; i++) {
    const serviceName = ZOOM_SERVICES[i];

    if (onProgress) {
      onProgress({
        step: 'services',
        current: i + 1,
        total: ZOOM_SERVICES.length,
        message: `Removing service: ${serviceName}...`
      });
    }

    const result = await deleteService(serviceName);
    results.push({ name: serviceName, ...result });

    if (result.existed) {
      if (result.success) {
        deleted++;
        logger.ok(`Removed service: ${serviceName}`);
      } else {
        failed++;
        logger.error(`Failed to remove service: ${serviceName}`);
      }
    } else {
      logger.debug(`Service not found: ${serviceName}`);
    }
  }

  // Also find and remove any other Zoom-related services
  const additionalServices = await findZoomServices();
  for (const svc of additionalServices) {
    if (!ZOOM_SERVICES.includes(svc)) {
      const result = await deleteService(svc);
      if (result.success && result.existed) {
        deleted++;
        logger.ok(`Removed additional service: ${svc}`);
      }
    }
  }

  const success = failed === 0;
  logger.logStep('Remove Services', success, { deleted, failed });

  return { success, deleted, failed, results };
}

/**
 * Find all Zoom-related services
 * @returns {Promise<string[]>}
 */
async function findZoomServices() {
  try {
    const result = await runPowerShell(
      `Get-Service | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*cpt*' } | Select-Object -ExpandProperty Name`,
      { timeout: 15000 }
    );

    if (result.stdout) {
      return result.stdout.split('\n').map(s => s.trim()).filter(s => s);
    }
  } catch (e) {
    logger.debug('Error finding Zoom services', { error: e.message });
  }

  return [];
}

/**
 * Delete a scheduled task
 * @param {string} taskName - Task name
 * @returns {Promise<{success: boolean, existed: boolean}>}
 */
async function deleteScheduledTask(taskName) {
  // Check if task exists
  try {
    const result = await runPowerShell(
      `Get-ScheduledTask -TaskName "${taskName}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName`,
      { timeout: 10000 }
    );

    if (!result.stdout || !result.stdout.trim()) {
      return { success: true, existed: false };
    }
  } catch (e) {
    return { success: true, existed: false };
  }

  // Delete the task
  try {
    // Try schtasks command
    await spawnSafe('schtasks', ['/delete', '/tn', taskName, '/f'], { timeout: 15000 });

    // Verify deletion
    const checkResult = await runPowerShell(
      `Get-ScheduledTask -TaskName "${taskName}" -ErrorAction SilentlyContinue`,
      { timeout: 5000 }
    );

    const deleted = !checkResult.stdout || !checkResult.stdout.trim();
    return { success: deleted, existed: true, deleted };
  } catch (e) {
    // Try PowerShell
    try {
      await runPowerShell(
        `Unregister-ScheduledTask -TaskName "${taskName}" -Confirm:$false -ErrorAction Stop`,
        { timeout: 15000 }
      );
      return { success: true, existed: true };
    } catch (e2) {
      return { success: false, existed: true, error: e2.message };
    }
  }
}

/**
 * Remove all Zoom scheduled tasks
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, deleted: number, failed: number}>}
 */
async function removeAllZoomTasks(onProgress = null) {
  logger.section('Removing Scheduled Tasks');

  let deleted = 0;
  let failed = 0;
  const results = [];

  // Remove known tasks
  for (let i = 0; i < ZOOM_SCHEDULED_TASKS.length; i++) {
    const taskName = ZOOM_SCHEDULED_TASKS[i];

    if (onProgress) {
      onProgress({
        step: 'tasks',
        current: i + 1,
        total: ZOOM_SCHEDULED_TASKS.length,
        message: `Removing task: ${taskName}...`
      });
    }

    const result = await deleteScheduledTask(taskName);
    results.push({ name: taskName, ...result });

    if (result.existed) {
      if (result.success) {
        deleted++;
        logger.ok(`Removed task: ${taskName}`);
      } else {
        failed++;
        logger.error(`Failed to remove task: ${taskName}`);
      }
    } else {
      logger.debug(`Task not found: ${taskName}`);
    }
  }

  // Find and remove any other Zoom-related tasks
  const additionalTasks = await findZoomTasks();
  for (const task of additionalTasks) {
    if (!ZOOM_SCHEDULED_TASKS.includes(task)) {
      const result = await deleteScheduledTask(task);
      if (result.success && result.existed) {
        deleted++;
        logger.ok(`Removed additional task: ${task}`);
      }
    }
  }

  const success = failed === 0;
  logger.logStep('Remove Scheduled Tasks', success, { deleted, failed });

  return { success, deleted, failed, results };
}

/**
 * Find all Zoom-related scheduled tasks
 * @returns {Promise<string[]>}
 */
async function findZoomTasks() {
  try {
    const result = await runPowerShell(
      `Get-ScheduledTask | Where-Object { $_.TaskName -like '*zoom*' } | Select-Object -ExpandProperty TaskName`,
      { timeout: 15000 }
    );

    if (result.stdout) {
      return result.stdout.split('\n').map(s => s.trim()).filter(s => s);
    }
  } catch (e) {
    logger.debug('Error finding Zoom tasks', { error: e.message });
  }

  return [];
}

/**
 * Remove both services and scheduled tasks
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, services: Object, tasks: Object}>}
 */
async function cleanServicesAndTasks(onProgress = null) {
  const services = await removeAllZoomServices(onProgress);
  const tasks = await removeAllZoomTasks(onProgress);

  return {
    success: services.success && tasks.success,
    services,
    tasks
  };
}

module.exports = {
  stopService,
  deleteService,
  removeAllZoomServices,
  findZoomServices,
  deleteScheduledTask,
  removeAllZoomTasks,
  findZoomTasks,
  cleanServicesAndTasks
};
