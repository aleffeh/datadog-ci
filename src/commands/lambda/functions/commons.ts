import {CloudWatchLogs, Lambda} from 'aws-sdk'
import {GetFunctionRequest} from 'aws-sdk/clients/lambda'
import {MAX_LAMBDA_STATE_CHECKS, Runtime, RUNTIME_LAYER_LOOKUP} from '../constants'
import {FunctionConfiguration} from '../interfaces'
import {applyLogGroupConfig} from '../loggroup'
import {applyTagConfig} from '../tags'

/**
 * Returns an array of merged layer ARNs if given a Full Layer ARN,
 * if not, it justs returns the layer ARNs provided.
 *
 * @param fullLayerARN a complete layer ARN.
 * @param partialLayerARN a partial layer ARN.
 * @param layerARNs an array of layer ARNs.
 * @returns an array of layer ARNs.
 */
export const addLayerARN = (fullLayerARN: string | undefined, partialLayerARN: string, layerARNs: string[]) => {
  if (fullLayerARN) {
    if (!layerARNs.includes(fullLayerARN)) {
      // Remove any other versions of the layer
      layerARNs = [...layerARNs.filter((l) => !l.startsWith(partialLayerARN)), fullLayerARN]
    }
  }

  return layerARNs
}

/**
 * Returns an arrayed grouped functions by its region, it
 * throws an error if there are functions without a region.
 *
 * @param functions an array of strings comprised by
 * Functions ARNs, Partial ARNs, or Function Names.
 * @param defaultRegion a fallback region
 * @returns an array of functions grouped by region
 */
export const collectFunctionsByRegion = (functions: string[], defaultRegion: string | undefined) => {
  const groups: {[key: string]: string[]} = {}
  const regionless: string[] = []
  for (const func of functions) {
    const region = getRegion(func) ?? defaultRegion
    if (region === undefined) {
      regionless.push(func)
      continue
    }
    if (groups[region] === undefined) {
      groups[region] = []
    }
    const group = groups[region]
    group.push(func)
  }
  if (regionless.length > 0) {
    throw Error(
      `No default region specified for ${JSON.stringify(regionless)}. Use -r,--region, or use a full functionARN\n`
    )
  }

  return groups
}

/**
 * Given a Lambda instance and an array of Lambda names,
 * return all the Lambda Function Configurations.
 *
 * @param lambda an instance of Lambda from aws-sdk.
 * @param functionARNs an array of strings comprised by
 * Functions ARNs, Partial ARNs, or Function Names.
 * @returns an array of Lambda FunctionConfiguration's.
 */
export const getLambdaFunctionConfigs = async (
  lambda: Lambda,
  functionARNs: string[]
): Promise<Lambda.FunctionConfiguration[]> => {
  const promises = functionARNs.map((fn) => getLambdaFunctionConfig(lambda, fn))
  const configs = await Promise.all(promises)

  return configs
}

/**
 * Call the aws-sdk Lambda api to get a Function given
 * an ARN and then return its Configuration.
 *
 * @param lambda an instance of Lambda from aws-sdk.
 * @param functionARN a string, can be Function ARN, Partial ARN, or a Function Name.
 * @returns the Lambda FunctionConfiguration of the given ARN.
 */
export const getLambdaFunctionConfig = async (
  lambda: Lambda,
  functionARN: string
): Promise<Lambda.FunctionConfiguration> => {
  const params: GetFunctionRequest = {
    FunctionName: functionARN,
  }
  const result = await lambda.getFunction(params).promise()
  // AWS typescript API is slightly mistyped, adds undefineds where
  // there shouldn't be.
  const config = result.Configuration!

  return config
}

/**
 * Given a Layer ARN, returns its layer name by splitting the string,
 * can return undefined if doesn't exist.
 *
 * @param layerARN a Layer ARN string.
 * @returns the layer name of a Layer ARN.
 */
export const getLayerName = (layerARN: string) => {
  const [, , , , , , layerName] = layerARN.split(':')

  return layerName
}

/**
 * Given a Function ARN, return its region by splitting the string,
 * can return undefined if it is doesn't exist.
 *
 * @param functionARN a string, can be Function ARN, Partial ARN, or a Function Name.
 * @returns the region of an ARN.
 */
export const getRegion = (functionARN: string): string | undefined => {
  const [, , , region] = functionARN.split(':')

  return region === undefined || region === '*' ? undefined : region
}

/**
 * Returns whether a Lambda Function is active or throws an error if
 * the FunctionConfiguration does not comply with `Successful` or `Active`.
 *
 * @param lambda an instance of Lambda from aws-sdk.
 * @param config a Lambda FunctionConfiguration.
 * @param functionArn a string, can be Function ARN, Partial ARN, or a Function Name.
 * @param attempts the number of attemps that have passed since the last retry.
 * @returns if a Lambda Function is active.
 */
export const isLambdaActive = async (
  lambda: Lambda,
  config: Lambda.FunctionConfiguration,
  functionArn: string,
  attempts = 0
): Promise<boolean> => {
  // TODO remove 1 Oct 2021 https://aws.amazon.com/blogs/compute/tracking-the-state-of-lambda-functions/
  if (!config.State || !config.LastUpdateStatus) {
    return true
  }
  if (config.LastUpdateStatus === 'Successful' && config.State === 'Active') {
    return true
  }
  if (config.State === 'Pending' && attempts <= MAX_LAMBDA_STATE_CHECKS) {
    await wait(2 ** attempts * 1000)
    const refetchedConfig = await getLambdaFunctionConfig(lambda, functionArn)

    return isLambdaActive(lambda, refetchedConfig, functionArn, (attempts += 1))
  }
  throw Error(
    `Can't instrument ${functionArn}, as current State is ${config.State} (must be "Active") and Last Update Status is ${config.LastUpdateStatus} (must be "Successful")`
  )
}

/**
 * Returns whether the runtime given is supported by the Datadog CI Lambda.
 *
 * @param runtime a string representing a Lambda FunctionConfiguration Runtime.
 * @returns if a runtime is supported.
 */
export const isSupportedRuntime = (runtime?: string): runtime is Runtime => {
  const lookup = RUNTIME_LAYER_LOOKUP as Record<string, string>

  return runtime !== undefined && lookup[runtime] !== undefined
}

export const sentenceMatchesRegEx = (sentence: string, regex: RegExp) => sentence.match(regex)

export const updateLambdaFunctionConfigs = async (
  lambda: Lambda,
  cloudWatch: CloudWatchLogs,
  configs: FunctionConfiguration[]
) => {
  const results = configs.map(async (c) => {
    if (c.updateRequest !== undefined) {
      await lambda.updateFunctionConfiguration(c.updateRequest).promise()
    }
    if (c.logGroupConfiguration !== undefined) {
      await applyLogGroupConfig(cloudWatch, c.logGroupConfiguration)
    }
    if (c.tagConfiguration !== undefined) {
      await applyTagConfig(lambda, c.tagConfiguration)
    }
  })
  await Promise.all(results)
}

/**
 * Waits for n ms
 *
 * @param ms
 */
const wait = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
