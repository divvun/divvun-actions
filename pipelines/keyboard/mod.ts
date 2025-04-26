// def create_divvun_keyboard_tasks(bundle, is_dev):
//     create_ios_keyboard_task(bundle, is_dev)
//     create_android_keyboard_task(bundle)

// def create_android_keyboard_task(bundle):
//     return (
//         macos_task(f"Build keyboard: Android")
//         .with_env(**{"ANDROID_HOME": "/usr/local/share/android-commandlinetools"})
//         .with_gha("setup", gha_setup())
//         .with_gha("init", gha_pahkat(["kbdgen"]))
//         .with_gha(
//             "build",
//             GithubAction(
//                 "divvun/taskcluster-gha/keyboard/build-meta",
//                 {"keyboard-type": "keyboard-android", "bundle-path": bundle},
//             ),
//         )
//         .with_gha(
//             "publish",
//             GithubActionScript(
//                 """
//                 REPO_PATH=`pwd`
//                 source ${DIVVUN_CI_CONFIG}/enc/env.sh
//                 cd $REPO_PATH/output/repo
//                 ./gradlew publishApk
//             """
//             )
//             .with_env("SPACESHIP_SKIP_2FA_UPGRADE", 1)
//             .with_env("LANG", "en_US.UTF-8"),
//             enabled=(CONFIG.git_ref == "refs/heads/main"),
//         )
//         .find_or_create(f"keyboard-build.android.{CONFIG.index_path}")
//     )

// def create_ios_keyboard_task(bundle, _is_dev):
//     ipa_name = "HostingApp.ipa"
//     return (
//         macos_task(f"Build keyboard: iOS")
//         .with_gha("setup", gha_setup())
//         .with_gha("init", gha_pahkat(["kbdgen"]))
//         .with_gha(
//             "build",
//             GithubAction(
//                 "divvun/taskcluster-gha/keyboard/build-meta",
//                 {"keyboard-type": "keyboard-ios", "bundle-path": bundle},
//             ),
//         )
//         .with_gha(
//             "publish",
//             GithubActionScript(
//                 """
//             fastlane pilot upload --api_key_path "${DIVVUN_CI_CONFIG}/enc/creds/macos/appstore-key.json" --skip_submission --skip_waiting_for_build_processing --ipa "output/ipa/%s"
//             """
//                 % ipa_name
//             )
//             .with_env("SPACESHIP_SKIP_2FA_UPGRADE", 1)
//             .with_env("LANG", "en_US.UTF-8"),
//             enabled=(CONFIG.git_ref == "refs/heads/main"),
//         )
//         .find_or_create(f"keyboard-build.ios.{CONFIG.index_path}")
//     )

// def macos_task(name):
//     return (
//         decisionlib.MacOsGenericWorkerTask(name)
//         .with_worker_type("macos")
//         .with_scopes("queue:get-artifact:private/*")
//         .with_scopes("queue:get-artifact:public/*")
//         .with_scopes("object:upload:divvun:*")
//         .with_scopes("secrets:get:divvun")
//         .with_index_and_artifacts_expire_in(BUILD_ARTIFACTS_EXPIRE_IN)
//         .with_max_run_time_minutes(60)
//         .with_provisioner_id("divvun")
//         .with_features("taskclusterProxy")
//         .with_script("mkdir -p $HOME/tasks/$TASK_ID")
//         .with_script("mkdir -p $HOME/tasks/$TASK_ID/_temp")
//         .with_additional_repo(
//             os.environ["CI_REPO_URL"],
//             "${HOME}/tasks/${TASK_ID}/ci",
//             branch=os.environ["CI_REPO_REF"],
//         )
//         .with_gha(
//             "clone",
//             GithubAction(
//                 "actions/checkout",
//                 {
//                     "repository": os.environ["REPO_FULL_NAME"],
//                     "path": "repo",
//                     "fetch-depth": 0,
//                 },
//                 enable_post=False,
//             ).with_secret_input("token", "divvun", "github.token"),
//             enabled=not CONFIG.index_read_only,
//         )
//         .with_additional_repo(
//             os.environ["GIT_URL"],
//             "${HOME}/tasks/${TASK_ID}/repo",
//             enabled=CONFIG.index_read_only,
//         )
//         .with_gha(
//             "Set CWD", GithubActionScript(f"echo ::set-cwd::$HOME/tasks/$TASK_ID/repo")
//         )
//     )

// def gha_setup():
//     return GithubAction("divvun/taskcluster-gha/setup", {}).with_secret_input(
//         "key", "divvun", "DIVVUN_KEY"
//     )

// def gha_pahkat(packages: List[str]):
//     return GithubAction(
//         "divvun/taskcluster-gha/pahkat/init",
//         {
//             "repo": "https://pahkat.uit.no/devtools/",
//             "channel": NIGHTLY_CHANNEL,
//             "packages": ",".join(packages),
//         },
//     )
