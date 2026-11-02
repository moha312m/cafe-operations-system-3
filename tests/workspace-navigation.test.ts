import {test} from "node:test";
import assert from "node:assert/strict";
import {currentWorkspaceHref} from "../src/lib/workspace-navigation";
test("table setup selects one specific leaf while the table workspace remains an ancestor",()=>{
 assert.equal(currentWorkspaceHref("/tables/setup",["/tables","/tables/setup","/pos"]),"/tables/setup");
 assert.equal(currentWorkspaceHref("/tables/setup/detail",["/tables/setup","/tables"]),"/tables/setup");
 assert.equal(currentWorkspaceHref("/tables-other",["/tables"]),undefined);
});
