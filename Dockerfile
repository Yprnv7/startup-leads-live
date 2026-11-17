FROM node:20-alpine AS base

WORKDIR /app

RUN apk add --no-cache python3 py3-pip

COPY package.json ./
RUN npm install -g serve

COPY . .

# Run data integrity validation tests inside build
RUN python3 tests/test_site_integrity.py && python3 tests/test_rti_data.py

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["serve", "-l", "3000", "-s", "."]
