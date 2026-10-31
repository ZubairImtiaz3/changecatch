# ChangeCatch user guide

## 1. What ChangeCatch does

HubSpot workflows can't start when records are linked, unlinked, or relabeled. ChangeCatch fills that gap.

- It notices when an **association is added**, **removed**, or its **label changes** (for example "Influencer" becomes "Decision maker").
- It works for **Contacts, Companies, Deals and custom objects**.
- For each change it updates a small set of **ChangeCatch properties** on the record. Your workflows trigger on those properties, like any other property.

---

## 2. Requirements

| You want to... | You need |
|---|---|
| Build workflows on ChangeCatch changes | **Pro or Enterprise** of a hub with workflows (for example Sales Hub, Service Hub or Operations Hub Pro) |
| Watch **custom objects** | **Enterprise** (custom objects are an Enterprise feature) |
| Install the app | A HubSpot **Super Admin**, or a user with permission to install apps |

---

## 3. Install and set up

### Install

1. Open the ChangeCatch install link (or the ChangeCatch listing on the HubSpot App Marketplace) and click **Install**.
2. Pick the HubSpot account you want to connect.
3. Review the permissions and click **Connect app**.
   - On an Enterprise account with custom objects, HubSpot shows a **second** permissions screen right away, for writing to custom objects. Approve it too. (HubSpot only grants these permissions this way.)
4. ChangeCatch now sets itself up. It creates a **"ChangeCatch"** property group with 7 properties on each object it watches. This takes a few seconds.

By default, ChangeCatch watches these pairs:

- Deal ↔ Contact
- Deal ↔ Company
- Company ↔ Contact

### The settings page

1. In HubSpot, go to **Settings** (gear icon) > **Integrations** > **Connected Apps**.
2. Click **ChangeCatch**, then open its **Settings** tab.
3. Under **Object pairs to watch**, tick the pairs you care about. Your custom objects are listed too (Enterprise only).
4. Under **Stamp spacing**, set the minimum seconds between two updates on the same record. The default is **3 seconds**. Leave it as is unless support tells you otherwise.
   - Why it exists: if one record changes several times very quickly, ChangeCatch waits this long between updates, so each change starts its own workflow run.
5. Click **Save**. A green "Saved" message confirms it.

If you see **"Setup did not finish"**, click **Save** again. It is safe to repeat.

### If your company uses app approval (app governance)

Some HubSpot accounts require a **super admin** to approve each app and its extra data permissions. In those accounts, turning on custom objects can fail with a HubSpot message like *"this app hasn't been approved to access the required scopes ... Please reach out to your account super admin"*.

**What works before approval:** everything for Contacts, Companies and Deals. Only custom-object pairs stay locked.

**What the super admin does:**

1. In HubSpot, go to **Settings** (gear icon) > **Integrations** > **Connected Apps**.
2. Open the **Approved apps** tab and click **ChangeCatch**. (Not listed yet? Click **Approve apps**, search for **ChangeCatch**, click **Approve**, then **Enable all**.)
3. Click **Manage access**.
4. Under data permissions, turn on the **custom object** permissions (read and write custom objects, and custom object schemas). Save.

**Then finish the setup:** open the ChangeCatch settings page (Connected Apps > **ChangeCatch** > **Settings**), click **Enable custom objects**, approve the permissions, come back and click **Refresh**. Custom-object pairs are now unlocked.

More on app approval: https://knowledge.hubspot.com/integrations/manage-access-to-apps

### Which record gets updated?

For each pair, ChangeCatch updates the record on **one side**: the first one in this order.

1. Custom object
2. Deal
3. Ticket
4. Company
5. Contact

| Pair | Record that gets the ChangeCatch update | Build your workflow on |
|---|---|---|
| Deal ↔ Contact | Deal | Deal-based workflow |
| Deal ↔ Company | Deal | Deal-based workflow |
| Company ↔ Contact | Company | Company-based workflow |
| Custom object ↔ Contact | Custom object record | Custom object workflow |

The ChangeCatch properties exist on both objects, but only the record in the table above gets new values. Build your workflow on that object.

---

## 4. The ChangeCatch properties

All 7 properties are in the **"ChangeCatch"** property group. ChangeCatch fills them in. Don't edit them by hand.

| Property (label in HubSpot) | Internal name | Type | Example values | What it means |
|---|---|---|---|---|
| **ChangeCatch: last change ID** | `changecatch_last_change_id` | Single-line text | `1793323347484-a3c78c57bc` | Gets a **new value on every change**. This is your **workflow trigger**. The value itself means nothing to you. |
| **ChangeCatch: change type** | `changecatch_change_type` | Dropdown | `ADDED`, `REMOVED`, `LABEL_CHANGED` | What kind of change it was. |
| **ChangeCatch: other object type** | `changecatch_other_object_type` | Single-line text | `Contact`, `Company`, `Deal`, `Ticket`, or a custom object's ID like `2-12345678` | The type of record on the other side of the link. |
| **ChangeCatch: other record ID** | `changecatch_other_record_id` | Single-line text | `51234567890` | The record ID on the other side of the link. |
| **ChangeCatch: labels before** | `changecatch_label_before` | Multiple checkboxes | `Influencer (Contact)`, `(none)` | The labels **before** the change. |
| **ChangeCatch: labels after** | `changecatch_label_after` | Multiple checkboxes | `Decision maker (Contact)`, `(none)` | The labels **after** the change. |
| **ChangeCatch: current labels** | `changecatch_labels_current` | Multiple checkboxes | `Decision maker (Contact)`, `Billing contact (Contact)` | All labels on that link right now. `(none)` after a removal. |

### How the label options look

The three label properties are dropdown-style lists. Each option reads **"Label (Object)"**:

- `Decision maker (Contact)` = the "Decision maker" label toward a **contact**.
- `Billing contact (Company)` = the "Billing contact" label toward a **company**.

The object name is there because the same label name can exist on two pairs. This way you pick exactly the one you mean.

Two special options:

- **`(none)`**: there were no labels (for example, "labels before" on a brand-new link).
- **`(unknown)`**: ChangeCatch couldn't tell. This mostly happens for links that existed **before** you installed ChangeCatch.

ChangeCatch adds options automatically when you create a new association label. You never need to type label names.

### What each change type fills in

| Change type | Labels before | Labels after | Current labels |
|---|---|---|---|
| `ADDED` (new link) | `(none)` | The new link's labels | Same as labels after |
| `REMOVED` (link deleted) | The labels it had | `(none)` | `(none)` |
| `LABEL_CHANGED` (link stays, labels change) | Old labels | New labels | All labels now |

> For a link that existed **before** ChangeCatch was installed, a label change shows only the **removed** label in "labels before" and only the **added** label in "labels after". "Current labels" may say `(unknown)`. The recipes below are written so they work in both cases.

---

## 5. Building workflows

### The core recipe (use this every time)

1. Go to **Automation** > **Workflows** > **Create workflow** > **From scratch**.
2. Choose the object that gets the ChangeCatch update (see "Which record gets updated?"). Example: **Deal-based**.
3. Click **Set up triggers** > **When an event occurs** > **Property value changed**.
4. Pick the property **ChangeCatch: last change ID**. Set the condition to **is known**.
5. Add your ChangeCatch conditions as **filters on this trigger** (the enrollment criteria). For example: "ChangeCatch: change type **is any of** LABEL_CHANGED".
6. Turn **re-enrollment ON** for this trigger. Without it, each record runs through the workflow only once.
7. Add your actions, then **Review and publish**.

Operators to use:

| Property type | Operators |
|---|---|
| Dropdown (change type) | **is any of**, **is none of** |
| Multiple checkboxes (labels) | **contains any of**, **doesn't contain any of** (in some accounts these show as "is any of" / "is none of") |
| Text (other object type) | **is equal to any of** |

---

### Example A: Tell the deal owner when a contact becomes "Decision maker"

Object: **Deal**. Pair watched: **Deal ↔ Contact**.

1. Create a **Deal-based** workflow.
2. Trigger: **Property value changed** > **ChangeCatch: last change ID** **is known**. Re-enrollment **ON**.
3. Add these filters to the trigger (all must be true):
   1. **ChangeCatch: change type** is any of `ADDED`, `LABEL_CHANGED`
   2. **ChangeCatch: labels after** contains any of `Decision maker (Contact)`
   3. **ChangeCatch: labels before** doesn't contain any of `Decision maker (Contact)`
4. Action: **Send internal notification** (or **Send in-app notification**) to **Deal owner**.
   - Message: "A contact was marked as Decision maker on {Deal name}. Contact record ID: {ChangeCatch: other record ID}."
5. Publish.

Filter 3 stops repeat alerts when another label changes on a contact who is already a Decision maker.

---

### Example B: When a company is unlinked from a deal, create a task

Object: **Deal**. Pair watched: **Deal ↔ Company**.

1. Create a **Deal-based** workflow.
2. Trigger: **ChangeCatch: last change ID** is known. Re-enrollment **ON**.
3. Filters on the trigger:
   1. **ChangeCatch: change type** is any of `REMOVED`
   2. **ChangeCatch: other object type** is equal to any of `Company`
4. Action: **Create task**.
   - Title: "Company removed from {Deal name}: check if this is correct"
   - Notes: "Removed company record ID: {ChangeCatch: other record ID}"
   - Assign to: **Deal owner**. Due: tomorrow.
5. Publish.

---

### Example C: When anything is linked to a custom object record, set a property

Object: your **custom object** (for example "Subscription"). Pair watched: for example **Subscription ↔ Contact** (Enterprise only).

1. Create a workflow based on your **custom object**.
2. Trigger: **ChangeCatch: last change ID** is known. Re-enrollment **ON**.
3. Filter on the trigger: **ChangeCatch: change type** is any of `ADDED`.
4. Action: **Edit record**. Set your own property (for example "Last linked on") to **the date the action runs**.
5. Optional: add a second action **Edit record** > "Status" = "Needs review".
6. Publish.

To react only to one partner type, add the filter **ChangeCatch: other object type** is equal to any of `Contact`.

---

### Example D: Alert when a label is removed

Object: **Deal**. Pair watched: **Deal ↔ Contact**. Goal: someone removes "Billing contact" from a contact on a deal (either by editing the label or by unlinking the contact).

1. Create a **Deal-based** workflow.
2. Trigger: **ChangeCatch: last change ID** is known. Re-enrollment **ON**.
3. Filters on the trigger:
   1. **ChangeCatch: change type** is any of `LABEL_CHANGED`, `REMOVED`
   2. **ChangeCatch: labels before** contains any of `Billing contact (Contact)`
   3. **ChangeCatch: labels after** doesn't contain any of `Billing contact (Contact)`
4. Action: **Send internal notification** to the **Deal owner** (or a finance team member): "Billing contact removed on {Deal name}. Contact record ID: {ChangeCatch: other record ID}. Please assign a new one."
5. Publish.

---

### Example E: Counting linked records (and rollup alternatives)

ChangeCatch tells you **that** something changed. For a **total**, you have two options.

**Option 1: HubSpot rollup properties (simplest).**

1. Go to **Settings** > **Properties** > choose the object (for example Deal) > **Create property**.
2. Field type: **Rollup** (or **Calculation** > count of associated records, depending on your account).
3. Count associated **Contacts**. If your account allows it, filter by association label (for example "Decision maker").
4. Use ChangeCatch to react **at the moment** of a change, and the rollup for the **total**. Rollups can take a while to update, so don't read them in the same instant as the ChangeCatch trigger.

**Option 2: Keep your own counter with two workflows.**

1. Create a number property, for example "Linked contacts (ChangeCatch)".
2. Workflow 1 (Deal-based): trigger **ChangeCatch: last change ID** is known, re-enrollment **ON**, filters **change type** is any of `ADDED` and **other object type** is equal to any of `Contact`. Action: **Edit record** > increase "Linked contacts (ChangeCatch)" by 1.
3. Workflow 2: same, but **change type** is any of `REMOVED`. Action: decrease the counter by 1.
4. This counter only counts changes made **after** install. Set the starting value once by hand, or use Option 1.

---

## 6. Best practices and one known limit

**Do:**

1. **Put ChangeCatch conditions in the trigger filters** (enrollment criteria). Make one workflow per case (one for "Decision maker added", another for "company removed", and so on).
2. **Use ChangeCatch values in tokens, branches or "copy property" steps only before any delay.**
3. Turn **re-enrollment ON** every time.
4. Watch only the pairs you use. It keeps your records' history tidy.

**Why:** the ChangeCatch properties always show the **latest** change on the record.

- The trigger filters are checked at the moment of the change. So two quick changes on the same record each enroll separately, with the **correct** values for each. This is safe.
- Steps **later** in a workflow (branches, tokens in emails or tasks, "copy property value") read the values **as they are at that moment**. If the record changed again while the workflow was running, those steps see the **newer** change. This is most likely after a **delay** step.

Example of the problem: a workflow waits 1 day, then sends an email using "ChangeCatch: labels after". If a different label changed on that deal during the day, the email shows the newer label.

**Fix:** put the condition in the trigger filters. If you need the value later, copy it into your own property **at the start** of the workflow (before any delay), then use your copy.

---

## 7. Troubleshooting and FAQ

### My workflow doesn't enroll records

Check these in order:

1. **Re-enrollment is off.** Open the trigger and turn re-enrollment ON. Without it, a record enrolls only on its first change.
2. **Wrong trigger property.** The trigger must be **Property value changed** on **ChangeCatch: last change ID**, with **is known**. Don't use "labels after" or "change type" as the trigger property; use them as filters.
3. **The pair isn't watched.** Open the ChangeCatch settings page and tick the pair. Changes made before you saved are not picked up.
4. **Workflow on the wrong object.** Only one side of each pair gets the update (see "Which record gets updated?"). For Deal ↔ Contact, build a **Deal**-based workflow, not a Contact-based one.
5. **Filters too strict.** Open a test record, check the ChangeCatch property values, and compare them with your filters. Watch for the object name in labels: `Decision maker (Contact)` is not the same option as `Decision maker (Company)`.
6. **The workflow is off.** Make sure it's turned on.

### How fast is it?

Usually **about 10 seconds** after the change, plus HubSpot's own workflow start time. If one record changes many times quickly, ChangeCatch spaces the updates by the "Stamp spacing" setting (3 seconds by default). During a fast burst on one record, several changes can be folded into one update, so you get a few workflow runs instead of hundreds. The last update always shows the record's latest state.

### I see `(unknown)` in a label property

ChangeCatch didn't know the full label set. This mostly happens for links that existed before you installed ChangeCatch. Once a link has been added while ChangeCatch is running, its labels are tracked fully. Recipes that check "labels after **contains any of**" and "labels before **doesn't contain any of**" still work.

### I created a new association label. Do I need to do anything?

No. ChangeCatch adds the new option to the label properties automatically the first time it sees it.

### Do changes from imports, integrations or other workflows count?

Yes. ChangeCatch picks up association changes no matter how they were made. ChangeCatch can't tell you **who** made the change in this version.

### Does ChangeCatch change my associations or other data?

No. ChangeCatch only **reads** association changes and label names, and only **writes** its own 7 ChangeCatch properties. It never adds, removes or relabels associations.

### What happens if I uninstall ChangeCatch?

- ChangeCatch **stops** updating records right away, so workflows that use it stop enrolling.
- The **ChangeCatch properties and their last values stay** in your account. HubSpot doesn't delete them. You can archive them yourself in **Settings** > **Properties** (filter by the "ChangeCatch" group). Turn off any workflows that use them first.
- If you reinstall later, ChangeCatch reuses the existing properties.

### I need help

Contact ChangeCatch support. Please include your HubSpot account ID, the record link, the approximate time of the change, and the name of the workflow.
