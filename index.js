const net = require('net')
const k8s = require('@kubernetes/client-node');
const crypto = require('crypto');
const pino = require('pino')
const logger = pino({
    transport: {
        target: 'pino-pretty'
    },
})


const ip = '0.0.0.0'
const ipPort = 8080
const namespace = process.env.NAMESPACE ? process.env.NAMESPACE : "test"
const orignalIngressClassName = process.env.UPSTREAM_INGRESS_CLASS_NAME ? process.env.UPSTREAM_INGRESS_CLASS_NAME : "nginx"
const podoIngressClassName = process.env.PODO_INGRESS_CLASS_NAME ? process.env.PODO_INGRESS_CLASS_NAME : "podo"
const podoServiceName = process.env.PODO_SERVICE_NAME ? process.env.PODO_SERVICE_NAME : "podo"
const podoServicePort = "http"
const maxRetry = process.env.STARTUP_RETRY_COUNT ? process.env.STARTUP_RETRY_COUNT : 60
const shutdownDeploymentAfterHours = process.env.INACTIVE_DEPLOYMENT_SHUTDOWN_TIME_H ? process.env.INACTIVE_DEPLOYMENT_SHUTDOWN_TIME_H : 10
const podoURL = process.env.PODO_INGRESS_URL ? process.env.PODO_INGRESS_URL : "http://192.168.17.177:6666/podo/"


logger.info("init k8s api")
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sDeployApi = kc.makeApiClient(k8s.AppsV1Api);
const k8snetApi = kc.makeApiClient(k8s.NetworkingV1Api);
var informer = undefined;

const lastUseMap = {}


async function patchIngressToOrig(key) {
    await k8snetApi.listNamespacedIngress(namespace, undefined, undefined, undefined, undefined, "podo.key=" + key)
        .then(async ingress => {
            const origIngress = await k8snetApi.readNamespacedIngress(ingress.body.items[0].metadata.labels["podo.autogenerated.from"], namespace)
            const options = { "headers": { "Content-type": k8s.PatchUtils.PATCH_FORMAT_STRATEGIC_MERGE_PATCH } }
            patch = { spec: { rules: origIngress.body.spec.rules } }
            await k8snetApi.patchNamespacedIngress(ingress.body.items[0].metadata.name, namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
        }).catch(e => logger.error(e))
}

async function verifyUp(key) {
    validEndpoints = await k8snetApi.listNamespacedIngress(namespace, undefined, undefined, undefined, undefined, "podo.key=" + key)
        .then(ingress => k8sApi.readNamespacedEndpoints(ingress.body.items[0].metadata.labels["podo.service.name"], namespace))
        .then(eps => eps.body).catch(e => logger.error(e))
    return (validEndpoints.subsets?.[0]?.addresses?.length > 0)
}


async function scaleDeployment(key, size) {
    validEndpoints = await k8snetApi.listNamespacedIngress(namespace, undefined, undefined, undefined, undefined, "podo.key=" + key)
        .then(ingress => k8sApi.readNamespacedService(ingress.body.items[0].metadata.labels["podo.service.name"], namespace))
        .then(service => service.body.spec.selector)
        .then(selector => Object.keys(selector).map(x => x + "=" + selector[x]).join(","))
        .then(selector => k8sDeployApi.listNamespacedDeployment(namespace, undefined, undefined, undefined, undefined, selector))
        .then(deployments => deployments.body.items[0])
        .then(async deployment => {
            if (deployment.spec.replicas != size) {
                const patch = { spec: { replicas: size } }
                const options = { "headers": { "Content-type": k8s.PatchUtils.PATCH_FORMAT_STRATEGIC_MERGE_PATCH } };
                await k8sDeployApi.patchNamespacedDeployment(deployment.metadata.name, namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
            }
        })
        .catch(e => logger.error(e))
    if (size === 0) {
        lastUseMap[key] = undefined
    }
}


logger.info("starting proxy")
var input = net.createServer(function (socket) {
    var client = undefined
    socket.on('data', async function (data) {
        try {
            if (client == undefined) {
                // logger.info(data.toString())
                if (!data.toString().match(/^GET \/podo\/([a-z0-9]*) (.*)$/m)) {
                    url = data.toString().match(/^[A-Z]* ([-a-zA-Z0-9()@:%_\+.~#?&//=]*) (.*)$/m)?.[1]
                    httpredirect(socket, url ? url : "/")
                    return
                }
                const podoKey = data.toString().match(/^GET \/podo\/([a-z0-9]*) (.*)$/m)[1];

                if (lastUseMap[podoKey]) {
                    lastUseMap[podoKey] = Date.now()
                    httprespond(socket, 200, "have fun")
                }
                // todo verify podokey
                var retry = 0
                up = await verifyUp(podoKey)
                while (retry < maxRetry && !up) {
                    await scaleDeployment(podoKey, 1)
                    await sleep(5)
                    retry++
                    up = await verifyUp(podoKey)
                    logger.info(socket.remoteAddress + ":" + socket.remotePort + " waiting 4 service " + podoKey + ". retry: " + retry)
                }
                if (retry >= maxRetry) {
                    logger.info(socket.remoteAddress + ":" + socket.remotePort + " waiting failed. sending 500")
                    scaleDeployment(podoKey, 0)
                    httprespond(socket, 500, "deployment did not come up")
                } else {
                    lastUseMap[podoKey] = Date.now()
                    await patchIngressToOrig(podoKey)
                    await sleep(4)
                    httprespond(socket, 200, "have fun")
                }
            }
        } catch (error) { logger.error(error); httprespond(socket, 500, "internal server error") }
    });
    // logger.info(socket.remoteAddress + ":" + socket.remotePort + " INCOMING")
});
input.listen(ipPort, ip)

initIngress()


async function initIngress() {
    logger.info("init ingress watcher")
    await deletePodoIngresses()

    const selector = "podo.managed!=true"
    const listFn = () => k8snetApi.listNamespacedIngress(namespace, undefined, undefined, undefined, undefined, selector)
    informer = k8s.makeInformer(kc, `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`, listFn, selector)

    informer.on('add', async (apiObj) => {
        if (apiObj.spec.ingressClassName != podoIngressClassName)
            return
        logger.info(`Added: ${apiObj.metadata.name}`);
        ingress = await createIngress(createPodoIngressFrom(apiObj))
        await scaleDeployment(ingress.body.metadata.labels["podo.key"], 0)
    });
    informer.on('update', async (apiObj) => {
        if (apiObj.spec.ingressClassName != podoIngressClassName)
            return
        logger.info(`Updated: ${apiObj.metadata.name}`);
        await deletePodoIngress(apiObj.metadata.name)
        await createIngress(createPodoIngressFrom(apiObj))
        await scaleDeployment(ingress.body.metadata.labels["podo.key"], 0)
    });
    informer.on('delete', async (apiObj) => {
        if (apiObj.spec.ingressClassName != podoIngressClassName)
            return
        logger.info(`Deleted: ${apiObj.metadata.name}`);
        await deletePodoIngress(apiObj.metadata.name)
    });
    informer.on("connect", () => {
        logger.info("k8s informer was connected...");
    });
    informer.on('error', (err) => {
        logger.error("k8s informer was terminated...", + err);
        // Restart informer after 5sec
        setTimeout(() => {
            logger.info("restarting informer", + err);
            initIngress()
        }, 5000);
    });
    informer.start();

    logger.info("done with init")
}



process.on('SIGINT', () => shutDown())
process.on('SIGTERM', () => shutDown())

async function shutDown() {
    await deletePodoIngresses()
    process.exit(0)
}

setInterval(() => cleanUpDeployments(), 1000 * 60 * 15)

async function cleanUpDeployments() {
    logger.info("cleanup Deployemnts")
    for (key in lastUseMap) {
        if (lastUseMap[key] + (shutdownDeploymentAfterHours * 1000 * 60 * 60) < Date.now()) {
            logger.info("Scaling down Service " + key);
            await restorePodoIngress(key)
            await scaleDeployment(key, 0)
        }
    }
}

async function deletePodoIngresses() {
    await k8snetApi.listNamespacedIngress(namespace, undefined, undefined, undefined, undefined, "podo.key")
        .then(async (res) => {
            await res.body.items.forEachAsync((item) => k8snetApi.deleteNamespacedIngress(item.metadata.name, item.metadata.namespace))
        }).catch(e => logger.error(e))
}


async function deletePodoIngress(name) {
    await k8snetApi.listNamespacedIngress(namespace, undefined, undefined, undefined, undefined, "podo.autogenerated.from=" + name)
        .then(podos => podos.body.items[0])
        .then(podo => {
            // logger.info(podo.body)
            lastUseMap[podo.metadata.labels["podo.key"]] = undefined
            logger.info("cleaned up " + podo.metadata.labels["podo.key"])
            k8snetApi.deleteNamespacedIngress(podo.metadata.name, namespace).catch(e => logger.error(e))
        }).catch(e => logger.error(e))

}

async function restorePodoIngress(key) {
    await k8snetApi.listNamespacedIngress(namespace, undefined, undefined, undefined, undefined, "podo.key=" + key)
        .then(async ingress => {
            const origIngress = await k8snetApi.readNamespacedIngress(ingress.body.items[0].metadata.labels["podo.autogenerated.from"], namespace)
            const options = { "headers": { "Content-type": k8s.PatchUtils.PATCH_FORMAT_STRATEGIC_MERGE_PATCH } }
            patch = createPodoIngressFrom(origIngress.body)
            await k8snetApi.patchNamespacedIngress(ingress.body.items[0].metadata.name, namespace, patch, undefined, undefined, undefined, undefined, undefined, options)
        }).catch(e => logger.error(e))
}

function createPodoIngressFrom(item) {
    const key = crypto.createHash('sha1').update(item.metadata.name).digest('hex')
    const metadata = new k8s.V1ObjectMeta();
    metadata.name = "podo-" + item.metadata.name
    metadata.labels = {}
    metadata.labels["podo.autogenerated.from"] = item.metadata.name
    metadata.labels["podo.key"] = key
    metadata.labels["podo.managed"] = "true"
    metadata.annotations = item.metadata.annotations ? item.metadata.annotations : {}
    metadata.annotations["nginx.ingress.kubernetes.io/auth-url"] = podoURL + key
    item.spec.ingressClassName = orignalIngressClassName
    item.spec.rules.forEach(rule => {
        rule.http.paths.forEach(path => {
            metadata.labels["podo.service.name"] = path.backend.service.name
            if (path.backend.service.port.number) {
                metadata.labels["podo.service.port.number"] = path.backend.service.port.number + ""

            }
            if (path.backend.service.port.name) {
                metadata.labels["podo.service.port.name"] = path.backend.service.port.name + ""
            }
            path.backend.service.name = podoServiceName
            path.backend.service.port.name = podoServicePort
            path.backend.service.port.number = undefined

        })
    })
    item.metadata = metadata
    return item
}

function createIngress(ingress) {
    return k8snetApi.createNamespacedIngress(namespace, ingress)
        .catch(e => logger.error(e))
}

async function httprespond(socket, httpCode, errorMsg) {
    const response =
        `HTTP/1.1 ${httpCode}
Server: Podo/0.1
Content-type: text, plain

${errorMsg}`;
    socket.write(response);
    socket.destroy()
}

async function httpredirect(socket, url) {
    const response =
        `HTTP/1.1 307
location: ${url}
Server: Podo/0.1
Content-type: text, plain

`;
    socket.write(response);
    socket.destroy()
}


function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

Array.prototype.forEachAsync = async function (fn) {
    for (let t of this) { await fn(t) }
}