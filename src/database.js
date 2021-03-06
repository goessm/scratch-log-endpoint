const ActionLog = require('./models/actionlog');
const Task = require('./models/task')
const mongoose = require('mongoose');
const props = require('./util/props');
require('dotenv').config();

const mongoString = process.env.MONGODB;
const retryDelay = 5000;

let unsavedActions = [];
let connecting = false;
let reconnectTimer;
let changeStream;
let taskCache = [];

/**
 * Establish mongoose connection to database.
 * Reconnects
 */
function connect() {
    clearTimeout(reconnectTimer)
    reconnectTimer = null

    if (connectionReady()) return
    if (connecting) return
    connecting = true;

    console.log('Trying to connect to database...')
    mongoose.connect(mongoString, function (err) {
        connecting = false
        if (err) {
            console.log(`Error connecting to database: ${err}. Retrying in ${retryDelay}ms`)
            _reconnect()
            return
        }
        console.log('Connected to database.')
        initLogID()
        mongoose.connection.on('error', (e) => {
            console.error(`MongoDB connection error: ${e}`)
            _reconnect()
        });
        // Update max log ID on delete by listening to change stream.
        // Note that change streams are only available on replica sets and sharded clusters.
        // https://docs.mongodb.com/manual/changeStreams/
        changeStream = ActionLog.model.watch()
        changeStream.on('change', data => {
            if (data.ns?.coll !== 'actionlogs') return
            if (data.operationType === 'delete') initLogID()
        });
        changeStream.on('error', e => {
            console.log('change stream error: ' + e)
        });
    });
}

function _reconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(connect, retryDelay)
}

/**
 * Retrieve current maximum log ID from database
 */
function initLogID() {
    const query = ActionLog.model.find().sort({logId: -1}).limit(1)
    query.exec(function (err, result) {
        if (err) {
            console.log('Error retrieving log ID')
            return
        }
        if (!result || result.length < 1 || !result[0].logId) {
            ActionLog.setMaxLogID(0)
        } else {
            ActionLog.setMaxLogID(result[0].logId)
        }
        saveUnsavedActions()
    })
}

/**
 * Save all actions in given array to database.
 * @param actions
 * @returns {string|undefined} Error string or undefined if no error
 */
function saveActions(actions) {
    if (!Array.isArray(actions)) return ('Invalid actions.')

    if (!connectionReady()) {
        unsavedActions.push(...actions)
        console.error('error saving actions: No database connection')
        console.log(`${unsavedActions.length} unsaved actions.`)
        connect()
        return ('No database connection')
    }
    saveUnsavedActions()

    for (const action of actions) {
        // Create documents and save actions
        saveAction(action).then(error => {
            if (error) console.log(error)
        })
    }
}

/**
 * Save given action to database.
 * @param action
 * @returns {Promise<string|*>} Error text or undefined
 */
async function saveAction(action) {
    if (props.ignoreInvalidTasks) {
        // Validate task
        const taskValid = await isValidTask(action.taskId)
        if (!taskValid) {
            return `ignoring action with invalid taskId: ${action.taskId}`
        }
    }
    // Create document
    const action_log_doc = new ActionLog.model(action)
    // Validate document
    const error = action_log_doc.validateSync();
    if (error) {
        let errMsg = 'Validation error'
        for (const field in error.errors) {
            const validatorError = error.errors[field]
            if (validatorError instanceof mongoose.Error.ValidatorError) {
                errMsg += `: ${validatorError.path}: ${validatorError.kind}`
            }
        }
        return errMsg
    }
    // Save document
    ActionLog.model.create(action_log_doc)
        .then(document => {
            console.log(`Saved document: ${document.get('type')}`)
        })
        .catch(error => {
            console.log(`Error saving document: ${error}`)
            unsavedActions.push(action)
        })
}

/**
 * Save all unsaved actions that failed to save before
 */
function saveUnsavedActions() {
    if (!unsavedActions || unsavedActions.length === 0) return
    console.log(`Saving ${unsavedActions.length} unsaved actions.`)
    let actionsToSave = [...unsavedActions]
    unsavedActions = []
    saveActions(actionsToSave)
}

/**
 * @returns {boolean} Whether mongoose connection is ready
 */
function connectionReady() {
    return mongoose.connection.readyState === mongoose.STATES.connected;
}

async function isValidTask(taskId) {
    if (taskCache.includes(taskId)) return true // Accept tasks from cache
    const taskExists = await Task.model.exists({taskId: taskId}).catch(error => {
        console.log(`Error validating task: ${error}`)
        return false
    })
    if (taskExists && !taskCache.includes(taskId)) taskCache.push(taskId) // Add valid taskId to cache
    return taskExists
}

function addTask(taskId) {
    Task.model.init().then(() => {
        Task.model.create({taskId: taskId})
            .then(document => {
                console.log(`Saved task: ${document.get('taskId')}`)
            })
            .catch(error => {
                console.log(`Error saving task: ${error}`)
            })
    });
}

function getFirstActionlog(taskId, userId) {
    return new Promise((resolve, reject) => {
        const query = {
            $and: [
                {userId: userId},
                {taskId: taskId},
                {codeState: { $ne: null } }
            ]
        }
        ActionLog.model.findOne(query).sort({ timestamp: 1 }).exec((err, actionlog) => {
            console.log(`getFirst for user ${userId} returned ${actionlog?.type}`);
            if (err) {
                reject(err);
                return;
            }
            resolve(actionlog);
        });
    });
}

function getLastActionlog(taskId, userId) {
    return new Promise((resolve, reject) => {
        const query = {
            $and: [
                {userId: userId},
                {taskId: taskId},
                {codeState: { $ne: null } }
            ]
        }
        ActionLog.model.findOne(query).sort({ timestamp: -1 }).exec((err, actionlog) => {
            console.log(`getLast for user ${userId} returned ${actionlog?.type}`);
            if (err) {
                reject(err);
                return;
            }
            resolve(actionlog);
        });
    });
}

function getNextActionlog(taskId, userId, timestamp) {
    return new Promise((resolve, reject) => {
        const query = {
            $and: [
                {'userId': userId},
                {'taskId': taskId},
                {'codeState': { $ne: null } },
                {'timestamp': { $gt: timestamp }}
            ]
        }
        ActionLog.model.findOne(query).sort({ timestamp: 1 }).exec((err, actionlog) => {
            console.log(`getNext for user ${userId} returned ${actionlog?.type}`);
            if (err) {
                reject(err);
                return;
            }
            resolve(actionlog);
        });
    });
}

function getPreviousActionlog(taskId, userId, timestamp) {
    return new Promise((resolve, reject) => {
        const query = {
            $and: [
                {'userId': userId},
                {'taskId': taskId},
                {'codeState': { $ne: null } },
                {'timestamp': { $lt: timestamp }}
            ]
        }
        ActionLog.model.findOne(query).sort({ timestamp: -1 }).exec((err, actionlog) => {
            console.log(`getPrevious for user ${userId} returned ${actionlog?.type}`);
            if (err) {
                reject(err);
                return;
            }
            resolve(actionlog);
        });
    });
}

module.exports = {
    connect: connect,
    connectionReady: connectionReady,
    saveActions: saveActions,
    getFirstActionlog: getFirstActionlog,
    getLastActionlog: getLastActionlog,
    getNextActionlog: getNextActionlog,
    getPreviousActionlog: getPreviousActionlog
};
