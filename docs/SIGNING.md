# Signing the desktop installers

Unsigned installers make Windows show "Windows protected your PC" (SmartScreen)
and make macOS refuse to open the app until the user right-clicks it. Signing
proves who made the installer; on macOS, Apple also has to *notarize* it
(scan it and issue a ticket).

The **Desktop app** workflow signs automatically once the secrets below exist.
It signs pushes to `Primary` and manual runs (Actions → Desktop app → Run
workflow). PR builds stay unsigned so they don't spend notarization time. Each
platform is independent: set up only Mac, or only Windows, and the other keeps
building unsigned.

Add secrets and variables in GitHub: repo **Settings → Secrets and variables →
Actions**. Secrets go on the *Secrets* tab, variables on the *Variables* tab.

## macOS: Apple Developer ID + notarization

**What to buy:** the [Apple Developer Program](https://developer.apple.com/programs/enroll/),
US$99 a year. Enroll as an organization if you want the company name shown
(needs a D-U-N-S number), or as an individual for your own name.

**Then:**

1. Make a **Developer ID Application** certificate. Easiest on a Mac: Xcode →
   Settings → Accounts → your team → Manage Certificates → **+** → Developer ID
   Application. (Or developer.apple.com → Certificates → **+**, upload a CSR
   from Keychain Access.)
2. Export it from Keychain Access (My Certificates → right-click the
   certificate → Export, `.p12` format) with a password.
3. Turn the file into text: on a Mac, `base64 -i cert.p12 | pbcopy`; on
   Windows PowerShell, `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.p12")) | Set-Clipboard`.
4. Make an app-specific password at [account.apple.com](https://account.apple.com)
   → Sign-In and Security → App-Specific Passwords. Notarization uses it.
5. Find your **Team ID** at developer.apple.com → Account → Membership details
   (10 characters, like `AB12CD34EF`).

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | the base64 text from step 3 |
| `APPLE_CERTIFICATE_PASSWORD` | the password from step 2 |
| `APPLE_ID` | the Apple ID email of the developer account |
| `APPLE_APP_PASSWORD` | the app-specific password from step 4 |
| `APPLE_TEAM_ID` | the Team ID from step 5 |

The workflow signs the app with the hardened runtime, has Apple notarize the
app and the disk image, and staples the tickets to both. Notarization adds
roughly 5 to 15 minutes to each Mac build. LibreOffice inside the app keeps The
Document Foundation's own signature.

## Windows: Azure Artifact Signing

**What to buy:** [Azure Artifact Signing](https://azure.microsoft.com/products/artifact-signing)
(formerly Trusted Signing), Basic plan, about US$9.99 a month. Microsoft holds
the key, so there is no USB token and nothing to renew by hand. Microsoft has
limited who can sign up (organizations in the US, Canada, EU and UK, and
individual developers in the US and Canada, at last check). If you aren't
eligible, see *Other Windows certificates* below.

**Then, in the [Azure portal](https://portal.azure.com):**

1. Create an **Artifact Signing account**. Note its region; the endpoint
   depends on it (for example East US is `https://eus.codesigning.azure.net`,
   West US 2 is `https://wus2.codesigning.azure.net`, West Europe is
   `https://weu.codesigning.azure.net`).
2. In the account, start **Identity validation** (Public, for the name users
   will see) and wait for it to be approved; this can take a few days.
3. Create a **Certificate profile** of type *Public Trust* using that identity.
4. Create an app for CI: Microsoft Entra ID → App registrations → New
   registration (any name, e.g. `pdf-pro-ci`). Copy its *Application (client)
   ID* and *Directory (tenant) ID*, then Certificates & secrets → New client
   secret, and copy the secret's *Value*.
5. Back in the Artifact Signing account: Access control (IAM) → Add role
   assignment → **Artifact Signing Certificate Profile Signer** → assign it to
   the app from step 4.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `AZURE_CLIENT_ID` | Application (client) ID |
| Secret | `AZURE_CLIENT_SECRET` | the client secret value |
| Secret | `AZURE_TENANT_ID` | Directory (tenant) ID |
| Variable | `AZURE_SIGNING_ENDPOINT` | the region endpoint from step 1 |
| Variable | `AZURE_SIGNING_ACCOUNT` | the Artifact Signing account name |
| Variable | `AZURE_SIGNING_PROFILE` | the certificate profile name |

The workflow signs `PDF Pro.exe`, the `.msi` and the setup `.exe` with
[artifact-signing-cli](https://crates.io/crates/artifact-signing-cli) through
Tauri's `signCommand`, then checks every signature.

**SmartScreen:** a brand-new certificate starts with no reputation, so some
users may still see a SmartScreen prompt for the first releases until enough
people have installed it. This is true of every certificate type today,
including EV.

### Other Windows certificates

Since June 2023, every OV or EV code-signing certificate must live on a
hardware token or a cloud HSM, so a plain `.pfx` file in a GitHub secret is no
longer an option. If Artifact Signing isn't available to you, buy a
certificate that comes with cloud signing (for example SSL.com eSigner or
Certum SimplySign) and we'll swap the `signCommand` in
`.github/workflows/desktop.yml` for that provider's tool.

## Checking a signed build

- Windows: right-click the installer → Properties → **Digital Signatures**.
- macOS: `spctl --assess --type open --context context:primary-signature -v "PDF Pro_macos-apple-silicon.dmg"`
  should say `accepted` and `source=Notarized Developer ID`.
