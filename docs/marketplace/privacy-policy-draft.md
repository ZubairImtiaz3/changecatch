# DRAFT – needs legal review

> **Not legal advice.** This is a plain-English starter draft. A qualified lawyer must review it before publishing. In particular, check GDPR (EU/UK), CCPA/CPRA (California), and Pakistan's data protection rules.
> Fill in every `[PLACEHOLDER]`.
> Before publishing, make sure the code still does what this policy promises (see [listing-checklist.md](listing-checklist.md) item 37, and [shared-data-table.md](shared-data-table.md)).
> Hosting is not chosen yet. The subprocessor table, backup and log retention are placeholders until it is.

---

# ChangeCatch Privacy Policy

**Last updated:** [DATE]

This policy explains what data ChangeCatch (the "App") handles, why, and for how long. The App is provided by **[COMPANY]** ("we", "us"), [COMPANY LEGAL ADDRESS], [COMPANY REGISTRATION NUMBER, if any].

Contact for privacy questions: **[PRIVACY EMAIL]**

## 1. What the App does

The App connects to your HubSpot account. It notices when records are linked, unlinked, or have their association label changed. It then writes the details of that change into App-owned properties on the record, so your HubSpot workflows can react to it.

## 2. Who is who

- **You (the HubSpot account owner)** control your HubSpot data. Under GDPR, you are the **controller**.
- **We** handle that data only to run the App for you. Under GDPR, we are your **processor**. *[Lawyer: confirm the roles and whether a Data Processing Agreement (DPA) is offered; link it here: [DPA URL].]*
- **HubSpot** is a separate company. Its own privacy policy covers your use of HubSpot.

## 3. Data we access in your HubSpot account

**We read:**
- Association change events: which two records were linked or unlinked, their object types, record IDs, the association type and label, and the time.
- Your association label names (for example "Decision maker").
- The names of your custom objects (only if you enable custom objects).

**We write:**
- A "ChangeCatch" property group and 7 App-owned properties (names starting with `changecatch_`) on the object types you choose.
- The values of those properties, on the records whose associations changed.

**We do not read** contact names, email addresses, phone numbers, deal amounts, notes, emails, files, or any other record property values. We don't create, delete, or merge your records, and we don't change your associations.

## 4. Data we store on our servers

| Data | Purpose | How long we keep it |
|---|---|---|
| Your HubSpot account (portal) ID and install / uninstall times | To know which account a change belongs to | While installed. After you uninstall, kept for **30 days** (without any token) so we can recognise late uninstall messages from HubSpot, then deleted. |
| OAuth refresh token (encrypted) | To act in your HubSpot account on your behalf | While installed. **Deleted when you uninstall.** |
| Granted permissions (scopes) | To know which features you can use | While installed. Deleted when you uninstall. |
| Your settings (which object pairs to watch) | To run the App the way you chose | While installed. Deleted when you uninstall. |
| Association label definitions (label names per object pair) | To turn label IDs into readable names | Cached up to **30 days**. Deleted when you uninstall. |
| Last known labels per pair of linked records (record IDs and label names) | To show which labels a link had before a change | Up to **90 days** after the last change. Deleted when you uninstall. |
| Change log: record IDs, object types, label names, change type, timestamps | To deliver each change once, and to debug problems | **30 days** while installed. **Deleted immediately** when you uninstall. |
| Seen-event IDs (no CRM data) | To avoid processing the same change twice | Expire within **4 days** |
| Operational logs | To run and fix the service | About **[LOG RETENTION, e.g. 14] days**. Logs never contain tokens. |
| Encrypted database backups | To recover from failures | About **[BACKUP RETENTION, e.g. 30] days** of history |

We do not store names, email addresses, or other contact details from your CRM. Record IDs and label names can still relate to a person (for example a contact's record ID), so we treat them as personal data and protect them the same way.

**If you contact support**, we keep your name, email address and the message, so we can help you. *[Retention: X]*

## 5. Why we process this data (legal basis)

- To provide the App you installed (performance of a contract, or your instructions as controller).
- To keep the App secure and working (legitimate interest).
- We do **not** sell data, use it for advertising, or use it to train AI models.

## 6. Who we share data with (subprocessors)

We use these service providers to run the App:

| Subprocessor | What for | Location |
|---|---|---|
| [HOSTING PROVIDER] | Servers and database that run the App | [REGION] |
| [BACKUP STORAGE PROVIDER] | Encrypted database backups | [REGION] |

We will update this list before adding a new subprocessor. *[Lawyer: confirm the notice period.]* We may also share data if the law requires it.

## 7. International transfers

Our servers are in [REGION]. [COMPANY] is based in [COUNTRY]. When data moves between countries, we use [Standard Contractual Clauses / other safeguard]. *[Lawyer to complete.]*

## 8. Security

- OAuth refresh tokens are encrypted at rest. Tokens are never written to logs.
- Database backups are encrypted.
- All connections use HTTPS (TLS 1.2 or newer).
- Only [COMPANY] staff who need it can access production systems.
- We ask for only the HubSpot permissions the App needs. Custom-object permissions are requested only on HubSpot Enterprise accounts, which are the only accounts that have custom objects.

If we learn of a security breach affecting your data, we will tell you without undue delay, and within [72 hours] where the law requires.

## 9. When you uninstall

When you uninstall the App from HubSpot:
- We delete your OAuth token, your settings, and all data we hold for your account (change log, label caches and usage records), and stop all processing for your account.
- We keep only your account ID and install / uninstall times, without any token, for 30 days, then delete them.
- Seen-event IDs (which contain no CRM data) expire within 4 days.
- Copies in encrypted backups age out within about [BACKUP RETENTION] days. Operational logs age out within about [LOG RETENTION] days.
- **The App-owned properties and their values stay in your HubSpot account.** We no longer have access, so we can't remove them. You can archive them in HubSpot under Settings → Properties (filter by the "ChangeCatch" group, or search for "changecatch_").

To have your data deleted sooner, email [PRIVACY EMAIL].

## 10. Your rights

Depending on where you live, you may have the right to access, correct, delete, or export your data, and to object to or restrict processing. Contact [PRIVACY EMAIL]. If the request concerns people in your CRM, we will help you, as controller, to respond. You may also complain to your local data protection authority.

## 11. Children

The App is a business tool, and it is not meant for children under 16.

## 12. Changes to this policy

We will post changes on this page and update the date at the top. For important changes, we will also notify you by email or in the App.

## 13. Contact

[COMPANY], [ADDRESS] · [PRIVACY EMAIL] · [WEBSITE]
