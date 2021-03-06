/*******************************************************************************
 * Copyright (c) 2019 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/
const metricsService = require('../modules/metricsService');
const Logger = require('../modules/utils/Logger');
const cwUtils = require('../modules/utils/sharedFunctions');
const { getProjectFromReq } = require('../middleware/checkProjectExists');

const log = new Logger(__filename);

/**
 * Enable or disable the auto injection of metrics collector
 * @param project, the project
 * @return 202 if the specified setting was applied and build requested
 * @return 404 if the specified project does not exist
 * @return 500 if internal error
 */
async function inject(req, res) {
  let project;
  let user;
  try {
    const projectID = req.sanitizeParams('id');
    const injectMetrics = req.sanitizeBody('enable');
    user = req.cw_user;
    project = user.projectList.retrieveProject(projectID);
    if (!project) {
      const message = `Unable to find project ${projectID}`;
      log.error(message);
      res.status(404).send(message);
      return;
    }

    const projectDir = project.projectPath();
    if (injectMetrics) {
      await metricsService.injectMetricsCollectorIntoProject(project.projectType, project.language, projectDir);
    } else {
      await metricsService.removeMetricsCollectorFromProject(project.projectType, project.language, projectDir);
    }

    await user.projectList.updateProject({
      projectID: projectID,
      injectMetrics: injectMetrics
    });

    res.sendStatus(202);
  } catch (err) {
    log.error(err);
    res.status(500).send(err.info || err.message);
    return;
  }

  try {
    await syncProjectFilesIntoBuildContainer(project, user);
  } catch (err) {
    log.error(err);
  }
}

async function auth(req, res) {
  // Handle true as a string or boolean
  const disableMetricsAuth = req.sanitizeBody('disable') === 'true' || req.sanitizeBody('disable') === true;
  const user = req.cw_user;
  const project = getProjectFromReq(req);
  const projectDir = project.projectPath();

  try {
    if (disableMetricsAuth) {
      await metricsService.disableMicroprofileMetricsAuth(project.language, projectDir);
    } else {
      await metricsService.enableMicroprofileMetricsAuth(project.language, projectDir);
    }
    res.sendStatus(202);
  } catch (err) {
    log.error(err);
    res.status(500).send(err.info || err.message);
    return;
  }

  try {
    await syncProjectFilesIntoBuildContainer(project, user);
  } catch (err) {
    log.error(err);
  }
}

async function syncProjectFilesIntoBuildContainer(project, user){
  const globalProjectPath = project.projectPath();
  const projectRoot = cwUtils.getProjectSourceRoot(project);
  if (project.buildStatus != "inProgress") {
    if (!global.codewind.RUNNING_IN_K8S && project.projectType != 'docker' &&
      (!project.extension || !project.extension.config.needsMount)) {
      await cwUtils.copyProjectContents(
        project,
        globalProjectPath,
        projectRoot
      );
    }
    await user.buildProject(project, "build");
  } else {
    // if a build is in progress, wait 5 seconds and try again
    await cwUtils.timeout(5000)
    await syncProjectFilesIntoBuildContainer(project, user);
  }
}

module.exports = {
  inject,
  auth,
}
