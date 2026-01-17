TEST SCRIPTS FOR 1132 REMOVER
==============================

Test Matrix Scripts:

1. run-dev.bat          - Run app in dev mode (non-admin) - Test #1
2. run-admin.bat        - Run app elevated via UAC - Test #2
3. create-test-task.bat - Create \Zoom\ZoomGifCollector task - Test #3
4. run-built-app.bat    - Launch the built installer
5. corrupt-msi-test.bat - Create corrupt MSI for Test #6

TEST MATRIX ORDER:
------------------

Test #1: Non-admin run
  - Double-click run-dev.bat
  - Enable reinstall
  - Check for: WARN about elevation, non-zero exit code, graceful summary

Test #2: Admin happy path
  - Double-click run-admin.bat (accept UAC)
  - Full Reset + Reinstall
  - Check for: durationMs, allClean: true, full summary

Test #3: Foldered scheduled task
  - Run create-test-task.bat AS ADMIN first
  - Then run the app cleanup
  - Check for: TaskPath discovery, deletion logged

Test #4: Already-clean system
  - Run admin reset twice back-to-back
  - Check for: zero deletes second time, no ERRORs

Test #5: Partial uninstall state
  - Install Zoom, manually delete C:\Program Files\Zoom
  - Run reset
  - Check for: registry + fingerprint still cleaned

Test #6: Corrupt MSI failure
  - Run corrupt-msi-test.bat first
  - Then run app with reinstall
  - Check for: fast failure, stderr captured, clean exit
