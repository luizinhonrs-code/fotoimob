import Replicate from 'replicate'

// Use module augmentation type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Prediction = any

export const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN!,
})

// Enhancement model - Clarity Upscaler
export const ENHANCE_MODEL = 'philz1337x/clarity-upscaler'
export const ENHANCE_VERSION = '3ca0dae8b43f72bbd9b6da7f0e38c9e0f0e19a3dc7a58c4e9db48ea7e3e6adb0'

// Grounded SAM for object detection
export const SAM_MODEL = 'adirik/grounded-sam'
export const SAM_VERSION = '801a8b24ce7e48398b9dcf24c73b8c9898e62c026f6da9b48c3e8c4b0c0ea8bf'

// Stable Diffusion Inpainting for declutter
export const INPAINT_MODEL = 'stability-ai/stable-diffusion-inpainting'
export const INPAINT_VERSION = 'c28b92a7ecd66eee4aefcd8a94eb9e7f6c3805d5f2fb120d4a80e5a86a7cc429'

// Clutter objects to detect
export const CLUTTER_PROMPT =
  'clothes, shoes, bags, handbag, laundry, dishes, cups, bottles, toys, personal items, clutter, mess, dirty dishes, clothing, socks'

// Poll a prediction until done or timeout
export async function pollPrediction(
  predictionId: string,
  maxWaitMs = 180000,
  intervalMs = 3000
): Promise<Prediction> {
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    const prediction = await replicate.predictions.get(predictionId)

    if (prediction.status === 'succeeded') {
      return prediction
    }

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      throw new Error(`Prediction ${predictionId} ${prediction.status}: ${prediction.error}`)
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Prediction ${predictionId} timed out after ${maxWaitMs}ms`)
}
