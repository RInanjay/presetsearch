FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Download Playwright browsers (Chromium)
RUN npx playwright install chromium

# Install system dependencies untuk Chromium
RUN npx playwright install-deps chromium

# Copy source
COPY . .

# Expose port
EXPOSE 3000

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Start
CMD ["node", "index.js"]
