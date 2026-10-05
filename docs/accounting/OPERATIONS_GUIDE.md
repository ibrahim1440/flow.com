# Operating guide (accountant)

## One-time set-up (Accounting → الترحيل الآلي والسياسات)
1. **Chart of accounts:** load the template (empty chart only) or create accounts; review names,
   codes and control flags with the external accountant.
2. **Fiscal year:** Periods → + Fiscal year (12 monthly periods, no overlaps).
3. **Posting roles:** map each role to a postable account (unmapped → automatic postings wait).
4. **Opening balances:** one OPENING journal at the day before cutover, prepared by one person and
   approved by another.
5. **Cutover date**, then **approve the commission policy** (someone other than its preparer) and
   **approve commission plan versions for accounting** (not the plan's author).
6. **Complete set-up.** Then "Run posting now".

## Daily / weekly
- Journals → "Awaiting approval": approve or reject (reason required). You cannot approve your own.
- Automatic posting → events: resolve anything **blocked** (the reason names the cause), then retry.

## Month-end
1. Post or reject every draft/submitted/approved entry dated in the month.
2. Automatic posting: no blocked/failed/pending events dated in the month.
3. Reports → trial balance balanced; commission reconciliation shows no difference.
4. Periods → **Lock** the month (stops posting; can be unlocked with a reason).
5. After review, **Close** it (final; requires earlier months closed and nothing pending).

## Corrections
Posted entries are never edited. Manual entry → "Request reversal" (approved by someone else), then
a new correct entry. Automatic entry → correct it in the commission module.
