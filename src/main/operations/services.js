/**
 * 1132 Remover - Services & Scheduled Tasks
 * Removes Zoom Windows services and scheduled tasks
 */

const { spawnSafe, runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_SERVICES, ZOOM_SCHEDULED_TASKS } = require('../../shared/constants');

/**
 * Check if a Windows service exists and is running using sc.exe (fast)
 * @param {string} serviceName - Service name
 * @returns {Promise<{exists: boolean, running: boolean}>}
 */
async function checkServiceStatus(serviceName) {
  try {
    const result = await spawnSafe('sc', ['query', serviceName], { timeout: 3000 });
    const output = result.stdout || '';

    if (output.includes('1060') || output.includes('does not exist')) {
      return { exists: false, running: false };
    }

    return { exists: true, running: output.includes('RUNNING') };
  } catch (e) {
    return { exists: false, running: false };
  }
}

/**
 * Stop a Windows service using sc.exe (fast) with net stop fallback
 * @param {string} serviceName - Service name
 * @returns {Promise<{success: boolean, stopped: boolean, existed: boolean, reason: string}>}
 */
async function stopService(serviceName) {
  const status = await checkServiceStatus(serviceName);

  if (!status.exists) {
    return { success: true, stopped: true, existed: false, reason: 'not_found' };
  }

  if (!status.running) {
    return { success: true, stopped: true, existed: true, reason: 'already_stopped' };
  }

  logger.debug(`Stopping service: ${serviceName}`);

  try {
    await spawnSafe('sc', ['stop', serviceName], { timeout: 5000 });
    await new Promise(r => setTimeout(r, 500));
    const newStatus = await checkServiceStatus(serviceName);

    if (!newStatus.running) {
      logger.ok(`Stopped service: ${serviceName}`);
      return { success: true, stopped: true, existed: true, reason: 'stopped' };
    }

    // Fallback: net stop
    await spawnSafe('net', ['stop', serviceName, '/y'], { timeout: 5000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));

    const finalStatus = await checkServiceStatus(serviceName);
    return {
      success: !finalStatus.running,
      stopped: !finalStatus.running,
      existed: true,
      reason: finalStatus.running ? 'failed' : 'stopped'
    };
  } catch (e) {
    logger.debug(`Error stopping ${serviceName}: ${e.message}`);
    return { success: false, stopped: false, existed: true, reason: 'error', error: e.message };
  }
}

/**
 * Stop all Zoom Windows services in parallel
 * @returns {Promise<{stopped: number, failed: number, services: Array}>}
 */
async function stopZoomServices() {
  logger.info('Stopping Zoom Windows services...');

  const results = [];
  let stopped = 0;
  let failed = 0;

  const serviceResults = await Promise.all(
    ZOOM_SERVICES.map(async (serviceName) => {
      const result = await stopService(serviceName);
      return { name: serviceName, ...result };
    })
  );

  for (const result of serviceResults) {
    results.push(result);
    if (result.existed && result.stopped) stopped++;
    else if (result.existed && !result.stopped) {
      failed++;
      logger.warn(`Failed to stop service: ${result.name}`);
    }
  }

  // Wildcard sweep for any service processes
  await spawnSafe('taskkill', ['/F', '/IM', 'CptService.exe'], { timeout: 3000 }).catch(() => {});
  await spawnSafe('taskkill', ['/F', '/IM', 'zCscptService.exe'], { timeout: 3000 }).catch(() => {});

  logger.logStep('Stop Zoom Services', failed === 0, { stopped, failed });
  return { stopped, failed, services: results };
}

/**
 * Delete a Windows service (uses fast sc.exe check instead of PowerShell)
 * @param {string} serviceName - Service name
 * @returns {Promise<{success: boolean, existed: boolean}>}
 */
async function deleteService(serviceName) {
  const status = await checkServiceStatus(serviceName);

  if (!status.exists) {
    return { success: true, existed: false };
  }

  // Stop the service first
  await stopService(serviceName);

  // Delete the service
  try {
    await spawnSafe('sc', ['delete', serviceName], { timeout: 15000 });

    // Verify deletion
    const newStatus = await checkServiceStatus(serviceName);
    return { success: !newStatus.exists, existed: true, deleted: !newStatus.exists };
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
 * Handles both simple task names and fully qualified paths (e.g., "Zoom\ZoomGifCollector")
 * @param {string} taskName - Task name or full path
 * @returns {Promise<{success: boolean, existed: boolean}>}
 */
async function deleteScheduledTask(taskName) {
  // Extract just the task name for Get-ScheduledTask (it doesn't accept paths)
  const simpleName = taskName.includes('\\') ? taskName.split('\\').pop() : taskName;

  // For schtasks, we need the full path with leading backslash
  const fullPath = taskName.startsWith('\\') ? taskName : `\\${taskName}`;

  // Check if task exists (search by simple name)
  try {
    const result = await runPowerShell(
      `Get-ScheduledTask -TaskName "${simpleName}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName`,
      { timeout: 10000 }
    );

    if (!result.stdout || !result.stdout.trim()) {
      return { success: true, existed: false };
    }
  } catch (e) {
    return { success: true, existed: false };
  }

  // Delete the task - try multiple approaches
  try {
    // Try schtasks with full path (handles folder-based tasks)
    await spawnSafe('schtasks', ['/delete', '/tn', fullPath, '/f'], { timeout: 15000 });

    // Verify deletion
    const checkResult = await runPowerShell(
      `Get-ScheduledTask -TaskName "${simpleName}" -ErrorAction SilentlyContinue`,
      { timeout: 5000 }
    );

    const deleted = !checkResult.stdout || !checkResult.stdout.trim();
    return { success: deleted, existed: true, deleted };
  } catch (e) {
    // Try PowerShell Unregister-ScheduledTask
    try {
      await runPowerShell(
        `Unregister-ScheduledTask -TaskName "${simpleName}" -Confirm:$false -ErrorAction Stop`,
        { timeout: 15000 }
      );
      return { success: true, existed: true };
    } catch (e2) {
      // Final fallback: try with wildcard search and delete
      try {
        await runPowerShell(
          `Get-ScheduledTask | Where-Object { $_.TaskName -like '*${simpleName}*' } | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue`,
          { timeout: 15000 }
        );
        return { success: true, existed: true };
      } catch (e3) {
        return { success: false, existed: true, error: e2.message };
      }
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
        // Downgrade to warn - task may have been removed by another process or is permission-restricted
        logger.warn(`Task not found or already removed: ${taskName}`, { error: result.error });
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
 * Returns fully qualified task names (path + name) for proper deletion
 * @returns {Promise<string[]>}
 */
async function findZoomTasks() {
  try {
    // Search by both TaskName AND TaskPath to catch tasks in folders like \Zoom\
    const result = await runPowerShell(
      `Get-ScheduledTask | Where-Object {
        $_.TaskName -like '*zoom*' -or
        $_.TaskPath -like '*zoom*'
      } | ForEach-Object {
        ($_.TaskPath + $_.TaskName).TrimStart('\\')
      }`,
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
 * Remove WMI event subscriptions that Zoom may have registered
 * These can auto-restart services or monitor Zoom state
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function removeWmiSubscriptions() {
  logger.info('Removing Zoom WMI event subscriptions...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0
      $namespaces = @('root\\subscription', 'root\\default')

      foreach ($ns in $namespaces) {
        # Event Filters
        Get-WmiObject -Namespace $ns -Class '__EventFilter' -ErrorAction SilentlyContinue | Where-Object {
          $_.Name -like '*zoom*' -or $_.Name -like '*cpt*' -or $_.Query -like '*zoom*'
        } | ForEach-Object {
          $_ | Remove-WmiObject -ErrorAction SilentlyContinue
          $count++
        }

        # Event Consumers
        Get-WmiObject -Namespace $ns -Class 'CommandLineEventConsumer' -ErrorAction SilentlyContinue | Where-Object {
          $_.Name -like '*zoom*' -or $_.CommandLineTemplate -like '*zoom*'
        } | ForEach-Object {
          $_ | Remove-WmiObject -ErrorAction SilentlyContinue
          $count++
        }

        # Filter-to-Consumer Bindings
        Get-WmiObject -Namespace $ns -Class '__FilterToConsumerBinding' -ErrorAction SilentlyContinue | Where-Object {
          $_.Filter -like '*zoom*' -or $_.Consumer -like '*zoom*'
        } | ForEach-Object {
          $_ | Remove-WmiObject -ErrorAction SilentlyContinue
          $count++
        }
      }

      Write-Output $count
    `, { timeout: 30000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Removed ${deleted} WMI event subscriptions`);
    }
  } catch (e) {
    logger.debug('WMI subscription cleanup skipped', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Remove both services, scheduled tasks, and WMI subscriptions
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, services: Object, tasks: Object, wmi: Object}>}
 */
async function cleanServicesAndTasks(onProgress = null) {
  const services = await removeAllZoomServices(onProgress);
  const tasks = await removeAllZoomTasks(onProgress);
  const wmi = await removeWmiSubscriptions();

  return {
    success: services.success && tasks.success,
    services,
    tasks,
    wmi
  };
}

module.exports = {
  checkServiceStatus,
  stopService,
  stopZoomServices,
  deleteService,
  removeAllZoomServices,
  findZoomServices,
  deleteScheduledTask,
  removeAllZoomTasks,
  findZoomTasks,
  removeWmiSubscriptions,
  cleanServicesAndTasks
};
