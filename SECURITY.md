# Security

Report a vulnerability by email to [vlad@submitator.com](mailto:vlad@submitator.com), not in a public
issue. Include the steps to reproduce it and what it lets someone do. The time of the calls, or their
request ids from the agency console's request log (they start with `mcp-`), help find them.

This covers the `submitator-mcp` npm package, the remote server at `https://mcp.submitator.com/mcp` with
its sign-in, and the Submitator API they call.

Test with your own agency and keys only, and leave real keys and your clients' data out of the report.
Test mode, with a `sbm_test_` key, submits nothing.
