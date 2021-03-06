/**
 * Makes sure the needed keys are present in the .env file.
 * Create a file called .env with keys as KEYNAME=VALUE if they are missing.
 */
const verifyEnv = () => {
    let exit = false;
    if (!process.env.MONGODB) {
        console.error('MongoDB String missing in env')
        exit = true
    }
    if (!process.env.LOGGING_AUTH_KEY) {
        console.error('Logging auth key missing in env')
        exit = true
    }
    if (exit) process.exit(1)
}

module.exports = {
    verifyEnv: verifyEnv
}
