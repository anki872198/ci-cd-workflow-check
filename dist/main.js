"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPullRequest = exports.getCurrentCommit = exports.updateBranch = exports.replace = exports.Parser = exports.run = exports.Environment = void 0;
const YAML = __importStar(require("js-yaml"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const jsonpath_1 = __importDefault(require("jsonpath"));
const rest_1 = require("@octokit/rest");
const core = __importStar(require("@actions/core"));
const getRepoInfo = (repo) => repo.split("/");
const serviceEmail = "dev@powerledger.io";
const serviceUserName = "pl-machine-account";
var Environment;
(function (Environment) {
    Environment["Staging"] = "staging";
    Environment["Sandbox"] = "sandbox";
    Environment["Production"] = "production";
})(Environment = exports.Environment || (exports.Environment = {}));
const run = () => {
    updateAllImages(core.getInput("services"), core.getInput("environment"), {
        createPR: core.getBooleanInput("createPR", { required: true }),
        token: core.getInput("token"),
        repo: core.getInput("repo"),
        labels: core.getInput("labels"),
        message: core.getInput("message"),
        title: core.getInput("title"),
        description: core.getInput("description"),
        mainBranch: core.getInput("mainBranch"),
        targetBranch: core.getInput("targetBranch"),
        syncWith: core.getInput("syncWith"),
        branch: core.getInput("branch"),
        directPush: core.getBooleanInput("directPush", { required: true }),
    }, core.getInput("workDir"));
};
exports.run = run;
exports.Parser = {
    convert(filePath) {
        return YAML.load(fs.readFileSync(filePath, "utf8"));
    },
    dump(content) {
        return YAML.dump(content, {
            lineWidth: -1,
        });
    },
};
/**
 *
 * @param files comma separated string
 * @param environment
 */
const updateAllImages = async (services, environment, options, workDir = ".") => {
    try {
        const [repoOwner, repo] = getRepoInfo(options.repo);
        const octokit = new rest_1.Octokit({
            auth: options.token,
            baseUrl: "https://api.github.com",
        });
        const servicesArray = services.split(",");
        const filesContent = [];
        for await (const service of servicesArray) {
            const file = `apps/${service.trim()}/overlays/${environment.trim()}/patch-deployment.yaml`;
            const filePath = path.join(process.cwd(), workDir, file);
            let contentNode = exports.Parser.convert(filePath);
            let contentString = exports.Parser.dump(contentNode);
            const initContent = contentString;
            const refFile = `apps/${service.trim()}/overlays/${options.syncWith.trim()}/patch-deployment.yaml`;
            const doc = exports.Parser.convert(path.join(process.cwd(), workDir, refFile));
            core.setOutput("valueToReplace", doc.spec.template.spec.containers[0].image);
            contentNode = replace(doc.spec.template.spec.containers[0].image, contentNode);
            contentString = exports.Parser.dump(contentNode);
            if (initContent === contentString) {
                continue;
            }
            const changedFile = {
                relativePath: file,
                absolutePath: filePath,
                content: contentString,
                json: contentNode,
            };
            fs.writeFile(filePath, contentString, (err) => {
                if (!err)
                    return;
                console.log("error");
            });
            filesContent.push(changedFile);
        }
        if (!filesContent?.length) {
            return null;
        }
        const branch = options.directPush
            ? options.mainBranch
            : options.branch || `${environment}-tags`;
        const { commitSha, treeSha } = await (0, exports.getCurrentCommit)(octokit, branch, repoOwner, repo);
        core.debug(JSON.stringify({ baseCommit: commitSha, baseTree: treeSha }));
        const debugFiles = {};
        for await (const file of filesContent) {
            const { data } = await octokit.git.createBlob({
                owner: repoOwner,
                repo,
                content: file.content,
                encoding: "utf-8",
            });
            file[`sha`] = data.sha;
            debugFiles[file.relativePath] = file.sha;
        }
        core.debug(JSON.stringify(debugFiles));
        const tree = [];
        for (const file of filesContent) {
            tree.push({
                path: file.relativePath,
                mode: `100644`,
                type: `blob`,
                sha: file.sha,
            });
        }
        const { data } = await octokit.git.createTree({
            owner: repoOwner,
            repo,
            tree,
            base_tree: treeSha,
        });
        const newTreeSha = data.sha;
        core.debug(JSON.stringify({ createdTree: newTreeSha }));
        const { data: commitData } = await octokit.git.createCommit({
            owner: repoOwner,
            repo: repo,
            message: options.message,
            tree: newTreeSha,
            parents: [commitSha],
            author: {
                name: options.directPush ? serviceUserName : "github-actions[bot]",
                email: options.directPush
                    ? serviceEmail
                    : "2525789+github-actions[bot]@users.noreply.github.com",
            },
        });
        core.debug(JSON.stringify({ createdCommit: commitData.sha }));
        core.setOutput("commit", commitData.sha);
        await (0, exports.updateBranch)(octokit, branch, commitData.sha, repoOwner, repo, options.directPush);
        core.debug(`Complete`);
        if (options.createPR && !options.directPush) {
            await createPullRequest(branch, options, octokit, repoOwner, repo);
        }
    }
    catch (e) {
        core.setFailed(e.toString());
    }
};
function replace(value, content) {
    let jsonPath = "spec.template.spec.containers.0.image";
    const copy = JSON.parse(JSON.stringify(content));
    if (!jsonPath.startsWith("$")) {
        jsonPath = `$.${jsonPath}`;
    }
    jsonPath = jsonPath.replace("[(@.length)]", "");
    jsonpath_1.default.value(copy, jsonPath, value);
    return copy;
}
exports.replace = replace;
const updateBranch = async (octo, branch, commitSha, repoOwner, repo, force = false) => {
    try {
        await octo.git.updateRef({
            owner: repoOwner,
            repo,
            ref: `heads/${branch}`,
            sha: commitSha,
            force: true,
        });
    }
    catch (error) {
        core.info(`update branch ${branch} failed (${error}), fallback to create branch`);
        await octo.git
            .createRef({
            owner: repoOwner,
            repo,
            ref: `refs/heads/${branch}`,
            sha: commitSha,
        })
            .catch((e) => core.setFailed(`failed to create branch: ${e}`));
    }
};
exports.updateBranch = updateBranch;
const getCurrentCommit = async (octo, branch, repoOwner, repo) => {
    let commitSha = "";
    try {
        const { data: refData } = await octo.git.getRef({
            owner: repoOwner,
            repo: repo,
            ref: `heads/${branch}`,
        });
        if (!refData.object?.sha) {
            throw Error(`Failed to get current ref from heads/${branch}`);
        }
        commitSha = refData.object?.sha;
    }
    catch (error) {
        const { data: refData } = await octo.git.getRef({
            owner: repoOwner,
            repo,
            ref: `heads/main`,
        });
        if (!refData.object?.sha) {
            throw Error(`Failed to get current ref from heads/master`);
        }
        commitSha = refData.object?.sha;
    }
    const { data: commitData } = await octo.git.getCommit({
        owner: repoOwner,
        repo,
        commit_sha: commitSha,
    });
    if (!commitData.tree?.sha) {
        throw Error("Failed to get the commit");
    }
    return {
        commitSha,
        treeSha: commitData.tree?.sha,
    };
};
exports.getCurrentCommit = getCurrentCommit;
async function createPullRequest(branch, options, octokit, repoOwner, repo) {
    const response = await octokit.pulls.create({
        owner: repoOwner,
        repo,
        title: options.title || `Merge: ${options.message}`,
        head: branch,
        base: options.targetBranch,
        body: options.description,
    });
    core.debug(`Create PR: #${response.data.id}`);
    core.setOutput("pull_request", JSON.stringify(response.data));
    octokit.issues.addLabels({
        owner: repoOwner,
        repo,
        issue_number: response.data.number,
        labels: options.labels.split(","),
    });
    core.debug(`Add Label: ${options.labels}`);
}
exports.createPullRequest = createPullRequest;
(0, exports.run)();
// const services = "account-service, orderbook-service";
// const environment = Environment.Sandbox;
// const options = {
//   createPR: true,
//   token: "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",
//   repo: "anki872198/CI-CD-Check-Branch",
//   labels: "sandbox-tags",
//   message: "something ",
//   title: "something",
//   description: "sdaf",
//   mainBranch: "temp-check/gh-actions",
//   syncWith: "development",
//   branch: "staging",
//   targetBranch: "temp-check/gh-actions",
//   directPush: true,
// };
// updateAllImages(services, environment, options, "./src/example/");
