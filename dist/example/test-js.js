"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const github_action_ts_run_api_1 = require("github-action-ts-run-api");
const main_1 = require("../main");
const fun = async () => {
    const target = github_action_ts_run_api_1.RunTarget.asyncFn(main_1.run);
    const options = github_action_ts_run_api_1.RunOptions.create().setInputs({
        mainBranch: "temp-check/gh-actions",
        targetBranch: "temp-check/gh-actions",
        repo: "anki872198/CI-CD-CHECK-BRANCH",
        services: "account-service, payment-service, orderbook-service, registry-service",
        value: "australia-southeast1-docker.pkg.dev/vital-contact-300805/powerledger-platform/tracex-web-app:5.5.6",
        environment: "staging",
        message: "Temp Check",
        createPR: "${{steps.pr-check.outputs.pr_exist!='true'}}",
        labels: "staging-tags",
        token: "${{secrets.GITHUB_TOKEN}}",
    });
    const result = await target.run(options);
};
