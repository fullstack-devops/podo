FROM node:18

WORKDIR /usr/src/app

COPY package.json yarn.lock ./

RUN yarn install

COPY *.js .

EXPOSE 8080
CMD [ "node", "index.js" ]