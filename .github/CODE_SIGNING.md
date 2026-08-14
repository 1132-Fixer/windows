# Code Signing Setup

This document explains how to configure code signing for CleanState Sentinel releases.

## Why Sign?

- **SmartScreen Trust**: Signed executables build reputation faster
- **Defender Compatibility**: Reduces false positive detections
- **User Confidence**: Verified publisher identity
- **Enterprise Deployment**: Many organizations require signed software

## Certificate Options

### Option 1: Standard Code Signing Certificate (~$100-300/year)

Providers:
- Sectigo (Comodo)
- DigiCert
- GlobalSign

Pros:
- Software-based (no hardware token required)
- Works with GitHub Actions directly
- Builds reputation over time (~1000 downloads)

### Option 2: EV Code Signing Certificate (~$400-600/year)

Providers:
- DigiCert
- Sectigo
- GlobalSign

Pros:
- Immediate SmartScreen reputation
- Higher trust level
- Required for kernel drivers

Cons:
- Requires hardware token (USB)
- Cannot use directly with cloud CI
- Requires self-hosted runner

## GitHub Actions Configuration

### For Standard Certificates

1. **Export certificate to PFX format**

   If you have separate .crt and .key files:
   ```bash
   openssl pkcs12 -export -out certificate.pfx -inkey private.key -in certificate.crt -certfile chain.crt
   ```

2. **Convert PFX to Base64**

   ```bash
   # Linux/macOS
   base64 -w 0 certificate.pfx > certificate.b64

   # Windows PowerShell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Out-File certificate.b64
   ```

3. **Add GitHub Secrets**

   Go to: Repository > Settings > Secrets and variables > Actions

   Add these secrets:
   - `CSC_LINK`: Paste the entire Base64 string from certificate.b64
   - `CSC_KEY_PASSWORD`: Your certificate password

4. **Verify**

   Push a new tag and check the release workflow:
   ```bash
   git tag -a v2.0.1 -m "Test signed release"
   git push origin v2.0.1
   ```

### For EV Certificates (Hardware Token)

EV certificates require physical access to the hardware token, so you need a self-hosted runner.

1. **Set up self-hosted runner**

   Repository > Settings > Actions > Runners > New self-hosted runner

2. **Install certificate on runner machine**

   - Insert hardware token
   - Import certificate to Windows Certificate Store
   - Note the certificate thumbprint

3. **Configure signing**

   Modify `.github/workflows/release.yml`:
   ```yaml
   - name: Build all targets (EV signed)
     env:
       CSC_LINK: "cert:\\CurrentUser\\My\\YOUR_THUMBPRINT"
       CSC_KEY_PASSWORD: ""  # Token PIN entered manually or via HSM
     run: npm run build:all
   ```

4. **Run on self-hosted runner**

   Change workflow:
   ```yaml
   runs-on: self-hosted
   ```

## Local Signing (Development)

For local builds with signing:

```bash
# Set environment variables
$env:CSC_LINK = "path\to\certificate.pfx"
$env:CSC_KEY_PASSWORD = "your-password"

# Build
npm run build:all
```

Or add to package.json (not recommended for public repos):

```json
{
  "build": {
    "win": {
      "certificateFile": "path/to/certificate.pfx",
      "certificatePassword": "your-password"
    }
  }
}
```

## Verifying Signatures

After building, verify the signature:

```powershell
# PowerShell
Get-AuthenticodeSignature "dist\CleanState Sentinel Setup 2.0.0.exe"

# Or use signtool
signtool verify /pa /v "dist\CleanState Sentinel Setup 2.0.0.exe"
```

Expected output should show:
- Status: Valid
- Publisher: High Texas (or your organization)
- Timestamp: Present (for longevity)

## Troubleshooting

### "Certificate not found"

- Ensure CSC_LINK is the full Base64 string, not a file path
- Check that CSC_KEY_PASSWORD is correct
- Verify certificate hasn't expired

### "SignTool Error: No certificates found"

- Certificate may not have code signing EKU
- Try re-exporting with full chain included

### SmartScreen still warns

- New certificates need time to build reputation
- Consider EV certificate for immediate trust
- Submit to Microsoft for analysis: https://www.microsoft.com/wdsi/filesubmission

## Security Best Practices

1. **Never commit certificates or passwords to git**
2. **Use GitHub Secrets for all sensitive values**
3. **Rotate certificates before expiration**
4. **Keep private keys secure** (HSM for EV certs)
5. **Enable branch protection** on `main`
6. **Require PR reviews** for release branches
7. **Use signed commits** for release tags

## Certificate Renewal

Set calendar reminders for:
- 30 days before expiration: Order renewal
- 14 days before expiration: Complete validation
- 7 days before expiration: Deploy new certificate

Update GitHub secrets with new certificate before old one expires.
