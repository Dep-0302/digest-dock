# Manual result records

Copy `../manual-run-template.json` once per provider/corpus run and save the
completed JSON in this directory. Use categorical notes only. The validator
rejects unknown fields, arbitrary notes, and non-whitelisted diagnostics so raw
transcript text, signed URLs, keys, tokens, headers, cookies, or job IDs cannot
enter the generated comparison report.

After the runs, execute `npm run report:manual` from the parent directory. The
generated `REPORT.md` summarizes success/failure, median elapsed time,
request-class counts, and failure codes by provider variant.
