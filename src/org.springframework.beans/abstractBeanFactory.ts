import { ICloseable, Exception } from "../java";
import {
  preDestroyHooksToken,
  postConstructHooksToken,
  resourceDependenciesToken,
  TResource
} from "../javax";
import { disposableToken } from "../rxjava";
import { beansToken } from "../org.springframework.context/annotations";
import { ILifecycle } from "../org.springframework.context/lifecycle";
import {
  TWishedBean,
  TBeanDefinition,
  dependenciesToken,
  TAutowire
} from "./annotations";
import { FactoryBean } from "./factoryBean";
import { TWishedBeanOrFactory, IBeanFactory, IResolver } from "./factory";
import { IResourceLoader } from "../org.springframework.context/resourceLoader";

//
// Types
//

const emptyMap = new Map<any, TWishedBeanOrFactory>();

//
// BeanFactory is a Ioc container
//

const PFX = "[ABSTRACT BEAN FACTORY]:";

/**
 * Abstract base class for IBeanFactory implementations.
 * @remark https://docs.spring.io/spring/docs/current/javadoc-api/org/springframework/beans/factory/support/AbstractBeanFactory.html
 */
export abstract class AbstractBeanFactory
  implements IBeanFactory, ILifecycle, ICloseable, IResourceLoader {
  public beansMap: Map<any, any>;
  public beanPathMap: Map<any, any>;
  protected running = false;

  protected abstract parentBeanFactory: AbstractBeanFactory;

  static beansMap: Map<any, any> = new Map();

  /* constructor */
  constructor() {
    this.beansMap = new Map();
    this.beanPathMap = new Map();
  }

  /**
   * Get resource from server.
   * @param url - json resource url.
   */
  public abstract async getResource(url: string): Promise<string>;

  /**
   * Retrieve instantiated bean from cache.
   */
  public findSingletonInstance(key: any) {
    if (this.beansMap.has(key)) {
      return this.beansMap.get(key);
    }

    if (this.parentBeanFactory) {
      return this.parentBeanFactory.findSingletonInstance(key);
    }

    return null;
  }

  /**
   * Retrieve instantiated bean from cache.
   */
  private findGlobalInstance(key: any) {
    if (AbstractBeanFactory.beansMap.has(key)) {
      return AbstractBeanFactory.beansMap.get(key);
    }

    return null;
  }

  /**
   * Set bean token mapping.
   * @param key - bean token.
   * @param value - target to which bean token will be mapped (bean name or token).
   */
  public set(key: Symbol, value: TWishedBeanOrFactory) {
    this.beanPathMap.set(key, value);
  }

  /**
   * Unset bean token mapping.
   * @param key - bean token to unset.
   */
  public unset(key: Symbol) {
    this.beanPathMap.delete(key);
  }

  /**
   * Set bean token mapping in batch way.
   * @param beanPathMap - map with beans mapping.
   */
  public configure(beanPathMap: Map<any, TWishedBeanOrFactory>) {
    for (const key of beanPathMap.keys()) {
      this.beanPathMap.set(key, beanPathMap.get(key));
    }
  }

  /**
   * Proxy beans to specified context.
   * @param context - context to inherit.
   * @param wishedBeans - beans to proxy to inherited context.
   */
  public inherit(context: AbstractBeanFactory, wishedBeans: TWishedBean[]) {
    for (const whishedBean of wishedBeans) {
      this.beanPathMap.set(
        whishedBean,
        FactoryBean.of(async () => await context.getBean(whishedBean))
      );
    }
  }

  /**
   * Proxy all not found beans to specified context.
   * @param context - context to search not found beans.
   */
  public setParent(context: AbstractBeanFactory) {
    this.parentBeanFactory = context;
  }

  /**
   * Execute all disposers in bean.
   * @param instance - bean.
   */
  public disposeBean(instance) {
    let key;
    let value;
    for (const entry of this.beansMap.entries()) {
      if (entry[1] === instance) {
        key = entry[0];
        value = entry[1];
        break;
      }
    }

    if (!key) {
      throw new Exception(`${PFX} no such bean instance`);
    }

    const bean = value;
    if (Reflect.hasMetadata(disposableToken, bean.constructor)) {
      const disposerKeys = Reflect.getMetadata(
        disposableToken,
        bean.constructor
      );
      disposerKeys.forEach(disposerKey => {
        if (bean[disposerKey] && bean[disposerKey] instanceof Function) {
          bean[disposerKey].call(bean);
          bean[disposerKey] = null;
        }
      });
    }
  }

  /**
   * Destroy specified bean.
   * @param instance - bean.
   */
  public destroyBean(instance) {
    let key;
    let value;
    for (const entry of this.beansMap.entries()) {
      if (entry[1] === instance) {
        key = entry[0];
        value = entry[1];
        break;
      }
    }

    if (!key) {
      throw new Exception(`${PFX} no such bean instance`);
    }

    const bean = value;

    this.disposeBean(bean);

    if (Reflect.hasMetadata(preDestroyHooksToken, bean.constructor)) {
      const preDestroyHook = Reflect.getMetadata(
        preDestroyHooksToken,
        bean.constructor
      );
      bean[preDestroyHook].call(bean);
    }

    this.beansMap.delete(key);
  }

  /**
   * Retrieve bean from cache. Similar to getBean but in sync way.
   * @param wishedBean - bean name or token.
   * @param required - if not found and not required function returns null.
   * @param extraBeanPathMap - extension of context bean mapping.
   * @param debug - show bean resolution to console.
   */
  public getCachedBean<T>(
    wishedBean: TWishedBeanOrFactory | T,
    required: boolean = true,
    extraBeanPathMap: Map<any, TWishedBeanOrFactory> = null,
    debug = false
  ): T | null {
    extraBeanPathMap = extraBeanPathMap || emptyMap;

    if (wishedBean == null) {
      throw new Exception(`${PFX} wished bean should not be null`);
    }

    // 1. resolve string path
    if (typeof wishedBean === "string") {
      // 1.1. resolve string path to either another string path or symbol token
      const nextWishedBean = this.resolveBean<T>(wishedBean, extraBeanPathMap);
      // 1.2. try again until get symbol token
      return this.getCachedBean<T>(
        nextWishedBean,
        required,
        extraBeanPathMap,
        debug
      );
    }

    // 2. get bean by symbol token
    if (typeof wishedBean === "symbol") {
      // 2.1 search in instances
      if (this.beansMap.has(wishedBean)) {
        return this.beansMap.get(wishedBean);
      }

      // 2.2. resolve symbol token to another token
      if (
        !this.beanPathMap.has(wishedBean) &&
        !extraBeanPathMap.has(wishedBean)
      ) {
        if (this.parentBeanFactory) {
          // 2.2.1. resolve in parents
          const newWishedBean = this.resolveBean<T>(
            wishedBean,
            extraBeanPathMap
          );
          if (!newWishedBean) {
            // 2.2.1.1. instantiate by token because parents not awared about this token
            return this.getCachedBeanByToken<T>(wishedBean, required);
          } else {
            // 2.2.1.2. try get again with new path that was resolved in parents
            return this.getCachedBean<T>(
              newWishedBean,
              required,
              extraBeanPathMap,
              debug
            );
          }
        } else {
          // 2.2.2. instantiate by token because there is no parents
          return this.getCachedBeanByToken<T>(wishedBean, required);
        }
      }

      // 2.3. resolve in itself
      const nextWishedBean = this.resolveBean<T>(wishedBean, extraBeanPathMap);
      // 2.4. try get again with new path that was resolved by itself
      return this.getCachedBean<T>(
        nextWishedBean,
        required,
        extraBeanPathMap,
        debug
      );
    }

    // 3. get bean by factory
    if (wishedBean instanceof FactoryBean) {
      const beanFactory = wishedBean as FactoryBean<T>;
      return beanFactory.factory();
    }

    // 4. bean is resolved from instances
    return wishedBean as any;
  }

  private getCachedBeanByToken<T>(token: Symbol, required: boolean): T | null {
    // 1. check beans definitions exists in package
    if (!Reflect.hasMetadata(beansToken, AbstractBeanFactory)) {
      throw new Exception(`${PFX} no beans found in context`);
    }

    // 2. find bean definition by type
    const beanDefinitions: TBeanDefinition<T>[] = Reflect.getMetadata(
      beansToken,
      AbstractBeanFactory
    );
    const beanDefinition: TBeanDefinition<T> = beanDefinitions.find(
      (beanDefinition: TBeanDefinition<T>) => beanDefinition.token === token
    ) as TBeanDefinition<T>;

    if (!beanDefinition) {
      if (required) {
        console.log(
          `${PFX} bean with such token not provided in context`,
          token
        );
        throw new Exception(
          `${PFX} bean with such token not provided in context`
        );
      }

      return null;
    }

    if (beanDefinition.factory == null && beanDefinition.bean == null) {
      throw new Exception(`${PFX} incorrect bean definition`);
    }

    // 3. get instance
    let bean: T;
    if (beanDefinition.scope === "singleton") {
      bean = this.findSingletonInstance(beanDefinition.token);
      if (!bean) {
        throw new Exception(
          `${PFX} retrieving from cache bean not instantiated yet`
        );
      }
    } else if (beanDefinition.scope === "global") {
      bean = this.findGlobalInstance(beanDefinition.token);
      if (!bean) {
        throw new Exception(
          `${PFX} retrieving from cache bean not instantiated yet`
        );
      }
    } else if (beanDefinition.scope === "prototype") {
      // instantiate
      throw new Exception(
        `${PFX} retrieving bean should not have prototype scope`
      );
    } else {
      throw new Exception(`${PFX} usupported scope - ${beanDefinition.scope}`);
    }

    return bean;
  }

  /**
   * Retrieve bean from cache.
   * @param wishedBean - bean name or token.
   * @param required - if not found and not required function returns null.
   * @param extraBeanPathMap - extension of context bean mapping.
   * @param debug - show bean resolution to console.
   */
  public async getBean<T>(
    wishedBean: TWishedBeanOrFactory | T,
    required: boolean = true,
    extraBeanPathMap: Map<any, TWishedBeanOrFactory> = null,
    debug = false
  ): Promise<T | null> {
    extraBeanPathMap = extraBeanPathMap || emptyMap;

    if (debug) {
      console.log(`${PFX} getBean`, wishedBean);
    }

    if (wishedBean == null) {
      throw new Exception(`${PFX} wished bean should not be null`);
    }

    // 1. resolve string path
    if (typeof wishedBean === "string") {
      // 1.1. resolve string path to either another string path or symbol token
      const nextWishedBean = this.resolveBean<T>(wishedBean, extraBeanPathMap);
      // 1.2. try again until get symbol token
      return await this.getBean<T>(
        nextWishedBean,
        required,
        extraBeanPathMap,
        debug
      );
    }

    // 2. get bean by symbol token
    if (typeof wishedBean === "symbol") {
      // 2.1 search in instances
      if (this.beansMap.has(wishedBean)) {
        return this.beansMap.get(wishedBean);
      }

      // 2.2. resolve symbol token to another token
      if (
        !this.beanPathMap.has(wishedBean) &&
        !extraBeanPathMap.has(wishedBean)
      ) {
        if (this.parentBeanFactory) {
          // 2.2.1. resolve in parents
          const newWishedBean = this.resolveBean<T>(
            wishedBean,
            extraBeanPathMap
          );
          if (!newWishedBean) {
            // 2.2.1.1. instantiate by token because parents not awared about this token
            return await this.getBeanByToken<T>(
              wishedBean,
              required,
              extraBeanPathMap,
              debug
            );
          } else {
            // 2.2.1.2. try get again with new path that was resolved in parents
            return await this.getBean<T>(
              newWishedBean,
              required,
              extraBeanPathMap,
              debug
            );
          }
        } else {
          // 2.2.2. instantiate by token because there is no parents
          return await this.getBeanByToken<T>(
            wishedBean,
            required,
            extraBeanPathMap,
            debug
          );
        }
      }

      // 2.3. resolve in itself
      const nextWishedBean = this.resolveBean<T>(wishedBean, extraBeanPathMap);
      // 2.4. try get again with new path that was resolved by itself
      return await this.getBean<T>(
        nextWishedBean,
        required,
        extraBeanPathMap,
        debug
      );
    }

    // 3. get bean by factory
    if (wishedBean instanceof FactoryBean) {
      const beanFactory = wishedBean as FactoryBean<T>;
      return beanFactory.factory();
    }

    // 4. bean is resolved from instances
    return wishedBean as any;
  }

  /**
   * Resolve bean name or token.
   * @param wishedBean - bean name or token.
   * @param extraBeanPathMap - extension of context bean mapping.
   */
  public resolveBean<T>(
    wishedBean: TWishedBean,
    extraBeanPathMap: Map<any, TWishedBeanOrFactory> = null
  ): TWishedBeanOrFactory {
    extraBeanPathMap = extraBeanPathMap || emptyMap;

    // 1. search in instances
    if (this.beansMap.has(wishedBean)) {
      return this.beansMap.get(wishedBean);
    }

    // 2. search bean path mapping in itself
    if (
      !this.beanPathMap.has(wishedBean) &&
      !extraBeanPathMap.has(wishedBean)
    ) {
      // 2.1. search bean path mapping in parents
      if (this.parentBeanFactory) {
        return this.parentBeanFactory.resolveBean<T>(
          wishedBean,
          extraBeanPathMap
        );
      }

      // 2.2. not resolved
      return null;
    }

    // 3. retrieve path mapping from itself
    if (this.beanPathMap.has(wishedBean)) {
      return this.beanPathMap.get(wishedBean);
    } else {
      return extraBeanPathMap.get(wishedBean);
    }
  }

  private async getBeanByToken<T>(
    token: Symbol,
    required: boolean,
    extraBeanPathMap: Map<any, TWishedBeanOrFactory>,
    debug: boolean = false
  ): Promise<T | null> {
    // 1. check beans definitions exists in package
    if (!Reflect.hasMetadata(beansToken, AbstractBeanFactory)) {
      throw new Exception(`${PFX} no beans found in context`);
    }

    // 2. find bean definition by type
    const beanDefinitions: TBeanDefinition<T>[] = Reflect.getMetadata(
      beansToken,
      AbstractBeanFactory
    );
    const beanDefinition: TBeanDefinition<T> = beanDefinitions.find(
      (beanDefinition: TBeanDefinition<T>) => beanDefinition.token === token
    ) as TBeanDefinition<T>;

    if (!beanDefinition) {
      if (required) {
        console.log(
          `${PFX} bean with such token not provided in context`,
          token
        );
        throw new Exception(
          `${PFX} bean with such token not provided in context`
        );
      }

      return null;
    }

    if (beanDefinition.factory == null && beanDefinition.bean == null) {
      throw new Exception(`${PFX} incorrect bean definition`);
    }

    // 3. get instance
    let bean: T;
    if (beanDefinition.scope === "singleton") {
      bean = this.findSingletonInstance(beanDefinition.token);
      if (!bean) {
        // instantiate
        bean = await this.instantiateBean(beanDefinition);
        this.beansMap.set(beanDefinition.token, bean);
        await this.autowire<T>(bean, beanDefinition, extraBeanPathMap, debug);
        await this.resource<T>(bean, beanDefinition);
      }
    } else if (beanDefinition.scope === "global") {
      bean = this.findGlobalInstance(beanDefinition.token);
      if (!bean) {
        // instantiate
        bean = await this.instantiateBean(beanDefinition);
        AbstractBeanFactory.beansMap.set(beanDefinition.token, bean);
        await this.autowire<T>(bean, beanDefinition, extraBeanPathMap, debug);
        await this.resource<T>(bean, beanDefinition);
      }
    } else if (beanDefinition.scope === "prototype") {
      // instantiate
      bean = await this.instantiateBean(beanDefinition);
      this.beansMap.set(Symbol(), bean);
      await this.autowire<T>(bean, beanDefinition, extraBeanPathMap, debug);
      await this.resource<T>(bean, beanDefinition);
    } else {
      throw new Exception(`${PFX} usupported scope - ${beanDefinition.scope}`);
    }

    if (beanDefinition.factory != null) {
      // 4. for configuration bean register all declared @beans
      if (Reflect.hasMetadata(beansToken, bean.constructor)) {
        const beansDefinitions = Reflect.getMetadata(
          beansToken,
          bean.constructor
        );
        beansDefinitions.forEach((beanDefinition: TBeanDefinition<any>) => {
          // register additional bean
          const beanDefinitions =
            Reflect.getMetadata(beansToken, AbstractBeanFactory) || [];
          Reflect.defineMetadata(
            beansToken,
            [
              {
                ...beanDefinition,
                bean
              },
              ...beanDefinitions
            ],
            AbstractBeanFactory
          );
          this.unset(beanDefinition.token);
        });
      }

      // 5. call post construct hook
      if (Reflect.hasMetadata(postConstructHooksToken, bean.constructor)) {
        const postConstructHook = Reflect.getMetadata(
          postConstructHooksToken,
          bean.constructor
        );
        const result = bean[postConstructHook].call(bean);
        if (result instanceof Promise) {
          await result;
        }
      }
    }

    return bean;
  }

  private async instantiateBean<T>(
    beanDefinition: TBeanDefinition<T>
  ): Promise<T> {
    if (beanDefinition.factory != null) {
      const type = beanDefinition.factory.prototype;
      return new type.constructor(this);
    }

    if (!beanDefinition.bean) {
      throw new Exception(`${PFX} bean should not be null`);
    }

    const bean = await beanDefinition.bean[beanDefinition.factoryProperty];
    return bean.call(beanDefinition.bean);
  }

  private async autowire<T>(
    bean: T,
    beanDefinition: TBeanDefinition<T>,
    extraBeanPathMap: Map<any, TWishedBeanOrFactory>,
    debug: boolean = false
  ) {
    if (!beanDefinition.factory) {
      return;
    }

    if (Reflect.hasMetadata(dependenciesToken, bean.constructor)) {
      const dependencies: TAutowire[] = Reflect.getMetadata(
        dependenciesToken,
        bean.constructor
      ) as TAutowire[];
      for (const dependency of dependencies) {
        // check property is empty
        const propertyName = dependency.property;
        const propertyValue = bean[propertyName];
        if (!propertyValue) {
          if (dependency.wishedBean == null) {
            throw new Exception(
              `${PFX} incorrect dependency definition for ${
                dependency.property
              }`
            );
          }
          if (dependency.resolve) {
            const resolverPath = beanDefinition.resolver;
            const resolverBean: IResolver<T> = await this.getBean(
              resolverPath,
              true,
              extraBeanPathMap,
              debug
            );
            const resolvedArray = resolverBean.resolve(
              dependency.resolve,
              bean
            );
            if (resolvedArray) {
              const resolverMap = new Map<any, any>(resolvedArray);
              extraBeanPathMap.forEach((v, k) => resolverMap.set(k, v));
              extraBeanPathMap = resolverMap;
            }
          }
          bean[propertyName] = await this.getBean(
            dependency.wishedBean,
            dependency.required,
            extraBeanPathMap,
            debug
          );
        } else {
          throw new Exception(
            `${PFX} autowired property should be null ${dependency.property}`
          );
        }
      }
    }
  }

  private async resource<T>(bean: T, beanDefinition: TBeanDefinition<T>) {
    if (!beanDefinition.factory) {
      return;
    }

    if (Reflect.hasMetadata(resourceDependenciesToken, bean.constructor)) {
      const resources: TResource[] = Reflect.getMetadata(
        resourceDependenciesToken,
        bean.constructor
      ) as TResource[];
      for (const resource of resources) {
        // check property is empty
        const propertyName = resource.property;
        const propertyValue = bean[propertyName];
        if (!propertyValue) {
          bean[propertyName] = await this.getResource(resource.url);
        } else {
          throw new Exception(
            `${PFX} resource property should be null ${resource.property}`
          );
        }
      }
    }
  }

  //
  // ICloseable implementation
  //

  /**
   * Destroy all beans in context and erase beans names mapping.
   */
  public close() {
    if (this.isRunning()) {
      this.stop();
    }
    this.beanPathMap = null;
    this.beansMap = null;
  }

  //
  // ILifecycle implementation
  //

  /**
   * Start context
   */
  public start() {
    if (!this.isRunning()) {
      if (this.beanPathMap && this.beansMap) {
        this.running = true;
      } else {
        throw new Exception(`${PFX} bean factory has not configured`);
      }
    } else {
      throw new Exception(`${PFX} bean factory already started`);
    }
  }

  /**
   * Destroy all beans in context but keep bean names mapping.
   */
  public stop() {
    if (this.isRunning()) {
      const disposeBeansKeys = this.beansMap.keys();
      for (const key of disposeBeansKeys) {
        const bean = this.beansMap.get(key);
        this.disposeBean(bean);
      }
      const destroyBeansKeys = this.beansMap.keys();
      for (const key of destroyBeansKeys) {
        const bean = this.beansMap.get(key);
        this.destroyBean(bean);
      }
      this.running = false;
    } else {
      throw new Exception(`${PFX} bean factory has not started`);
    }
  }

  /**
   * Wheather context running and beans ready to retrieving.
   */
  public isRunning(): boolean {
    return this.running;
  }
}
