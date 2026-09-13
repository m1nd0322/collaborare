# Release Artifacts

Run `scripts/Package-Extension.ps1 -ExpectedNodeVersion <approved-version>` on a connected or internally mirrored build machine to create and verify `collaborare-<version>.vsix` and its manifests in this directory.

Run `scripts/New-OfflineBundle.ps1 -ExpectedCollaborareVersion 0.1.1 -ExpectedNodeVersion <approved-version>` to create the Collaborare-owned offline payload ZIP and its external checksum sidecar.
