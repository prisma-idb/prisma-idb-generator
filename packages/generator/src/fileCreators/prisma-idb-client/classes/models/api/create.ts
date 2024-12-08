import { ClassDeclaration, CodeBlockWriter } from "ts-morph";
import { Field, Model } from "../../../../../fileCreators/types";
import { toCamelCase } from "../../../../../helpers/utils";

// TODO: nested connectOrCreate

export function addCreateMethod(modelClass: ClassDeclaration, model: Model, models: readonly Model[]) {
  modelClass.addMethod({
    name: "create",
    isAsync: true,
    typeParameters: [{ name: "Q", constraint: `Prisma.Args<Prisma.${model.name}Delegate, "create">` }],
    parameters: [
      { name: "query", type: "Q" },
      { name: "tx", hasQuestionToken: true, type: "IDBUtils.ReadwriteTransactionType" },
    ],
    returnType: `Promise<Prisma.Result<Prisma.${model.name}Delegate, Q, "create">>`,
    statements: (writer) => {
      createTx(writer);
      createDependencies(writer, model);
      createCurrentModel(writer, model);
      createDependents(writer, model, models);
      applyClausesAndReturnRecords(writer, model);
    },
  });
}

function createTx(writer: CodeBlockWriter) {
  writer
    .writeLine(`const storesNeeded = this._getNeededStoresForCreate(query.data);`)
    .writeLine(`tx = tx ?? this.client._db.transaction(Array.from(storesNeeded), "readwrite");`);
}

function createDependencies(writer: CodeBlockWriter, model: Model) {
  model.fields.forEach((field) => {
    if (!field.relationName) return;
    if (field.relationFromFields?.length === 0 || field.relationToFields?.length === 0) return;
    const foreignKeyField = model.fields.find((fkField) => fkField.name === field.relationFromFields?.at(0))!;

    writer.writeLine(`if (query.data.${field.name})`).block(() => {
      addOneToOneMetaOnFieldRelation(writer, field);
    });
    handleForeignKeyValidation(writer, field, foreignKeyField);
  });
}

function createCurrentModel(writer: CodeBlockWriter, model: Model) {
  writer
    .writeLine(`const record = this._removeNestedCreateData(await this._fillDefaults(query.data, tx));`)
    .writeLine(`const keyPath = await tx.objectStore("${model.name}").add(record);`);
}

function createDependents(writer: CodeBlockWriter, model: Model, models: readonly Model[]) {
  const allFields = models.flatMap((model) => model.fields);
  model.fields.forEach((field) => {
    if (!field.relationName) return;
    if (field.relationFromFields?.length || field.relationToFields?.length) return;
    const otherField = allFields.find(
      (otherField) => otherField !== field && otherField.relationName === field.relationName,
    )!;

    if (!field.isList) {
      addOneToOneMetaOnOtherFieldRelation(writer, field, otherField);
    } else {
      const dependentModel = models.find(({ name }) => name === field.type)!;
      const fks = dependentModel.fields.filter(
        (field) =>
          dependentModel.fields.find((fkField) => fkField.name === field.relationFromFields?.at(0)) !== undefined,
      );
      addOneToManyRelation(writer, field, otherField, fks);
    }
  });
}

function applyClausesAndReturnRecords(writer: CodeBlockWriter, model: Model) {
  writer
    .writeLine(`const data = (await tx.objectStore("${model.name}").get(keyPath))!;`)
    .write(`const recordsWithRelations = this._applySelectClause`)
    .write(`(await this._applyRelations([data], tx, query), query.select)[0];`)
    .writeLine(`this._preprocessListFields([recordsWithRelations]);`);

  writer.writeLine(`return recordsWithRelations as Prisma.Result<Prisma.${model.name}Delegate, Q, "create">;`);
}

function addOneToOneMetaOnFieldRelation(writer: CodeBlockWriter, field: Field) {
  writer
    .writeLine(`let fk;`)
    .writeLine(`if (query.data.${field.name}?.create)`)
    .block(() => {
      writer.writeLine(
        `fk = (await this.client.${toCamelCase(field.type)}.create({ data: query.data.${field.name}.create }, tx)).${field.relationToFields?.at(0)};`,
      );
    });

  writer.writeLine(`if (query.data.${field.name}?.connect)`).block(() => {
    writer
      .writeLine(
        `const record = await this.client.${toCamelCase(field.type)}.findUniqueOrThrow({ where: query.data.${field.name}.connect }, tx);`,
      )
      .writeLine(`delete query.data.${field.name}.connect;`)
      .writeLine(`fk = record.${field.relationToFields?.at(0)};`);
  });

  writer.writeLine(`if (query.data.${field.name}?.connectOrCreate)`).block(() => {
    writer.writeLine(`throw new Error('connectOrCreate not yet implemented')`);
  });

  writer
    .writeLine(`const unsafeData = query.data as Record<string, unknown>;`)
    .writeLine(`unsafeData.${field.relationFromFields?.at(0)} = fk as NonNullable<typeof fk>;`)
    .writeLine(`delete unsafeData.${field.name};`);
}

function addOneToOneMetaOnOtherFieldRelation(writer: CodeBlockWriter, field: Field, otherField: Field) {
  writer.writeLine(`if (query.data.${field.name}?.create)`).block(() => {
    writer
      .write(`await this.client.${toCamelCase(field.type)}.create(`)
      .block(() => {
        writer.writeLine(
          `data: { ...query.data.${field.name}.create, ${otherField.relationFromFields?.at(0)}: keyPath[0] }`,
        );
      })
      .writeLine(`, tx)`);
  });
  writer.writeLine(`if (query.data.${field.name}?.connect)`).block(() => {
    writer.writeLine(
      `await this.client.${toCamelCase(field.type)}.update({ where: query.data.${field.name}.connect, data: { ${otherField.relationFromFields?.at(0)}: keyPath[0] } }, tx);`,
    );
  });
  writer.writeLine(`if (query.data.${field.name}?.connectOrCreate)`).block(() => {
    writer.writeLine(`throw new Error('connectOrCreate not yet implemented')`);
  });
}

function addOneToManyRelation(writer: CodeBlockWriter, field: Field, otherField: Field, fkFields: Field[]) {
  writer.writeLine(`if (query.data.${field.name}?.create)`).block(() => {
    if (fkFields.length === 1) {
      writer
        .writeLine(`for (const createData of IDBUtils.convertToArray(query.data.${field.name}.create))`)
        .block(() => {
          writer.writeLine(
            `await this.client.${toCamelCase(field.type)}.create({ data: { ...createData, ${otherField.name}: { connect: { ${otherField.relationToFields?.at(0)}: keyPath[0] } } } }, tx);`,
          );
        });
    } else {
      /* 
        This is due to Prisma's create query's constraint of using either 
        { connect: { pk: value } } OR { fk: value } for all the fields
      */
      const otherFkField = fkFields.find(({ relationName }) => relationName !== field.relationName)!;
      writer
        .writeLine(`const createData = Array.isArray(query.data.${field.name}.create)`)
        .writeLine(`? query.data.${field.name}.create`)
        .writeLine(`: [query.data.${field.name}.create]`)
        .writeLine(`await Promise.all(`)
        .writeLine(`createData.map(async (elem) => `)
        .block(() => {
          writer
            .writeLine(`if ("${otherFkField.name}" in elem && !("${otherFkField.relationFromFields?.at(0)}" in elem))`)
            .block(() => {
              writer.writeLine(
                `await this.client.${toCamelCase(field.type)}.create({ data: { ...elem, ${otherField.name}: { connect: { ${otherField.relationToFields?.at(0)}: keyPath[0] } } } }, tx);`,
              );
            })
            .writeLine(`else if (elem.${otherFkField.relationFromFields?.at(0)} !== undefined)`)
            .block(() => {
              writer.writeLine(
                `await this.client.comment.create({ data: { ...elem, ${otherField.relationFromFields?.at(0)}: keyPath[0] } }, tx);`,
              );
            });
        })
        .writeLine(`))`);
    }
  });

  writer.writeLine(`if (query.data.${field.name}?.connect)`).block(() => {
    writer
      .writeLine(`await Promise.all(`)
      .indent(() => {
        writer
          .writeLine(`IDBUtils.convertToArray(query.data.${field.name}.connect).map(async (connectWhere) => `)
          .block(() => {
            writer.writeLine(
              `await this.client.${toCamelCase(field.type)}.update({ where: connectWhere, data: { ${otherField.relationFromFields?.at(0)}: keyPath[0] } }, tx);`,
            );
          })
          .writeLine(`),`);
      })
      .writeLine(");");
  });
  writer.writeLine(`if (query.data.${field.name}?.connectOrCreate)`).block(() => {
    writer.writeLine(`throw new Error('connectOrCreate not yet implemented')`);
  });
  writer.writeLine(`if (query.data.${field.name}?.createMany)`).block(() => {
    writer
      .write(`await this.client.${toCamelCase(field.type)}.createMany(`)
      .block(() => {
        writer
          .writeLine(`data: IDBUtils.convertToArray(query.data.${field.name}.createMany.data).map((createData) => (`)
          .block(() => {
            writer.writeLine(`...createData, ${otherField.relationFromFields?.at(0)}: keyPath[0]`);
          })
          .writeLine(`)),`);
      })
      .writeLine(`, tx)`);
  });
}

function handleForeignKeyValidation(writer: CodeBlockWriter, field: Field, fkField: Field) {
  writer
    .writeLine(`else if (query.data.${fkField.name} !== undefined && query.data.${fkField.name} !== null)`)
    .block(() => {
      // TODO: composite FKs
      writer
        .writeLine(`await this.client.${toCamelCase(field.type)}.findUniqueOrThrow(`)
        .block(() => {
          writer.writeLine(
            `where: { ${field.relationToFields?.at(0)}: query.data.${field.relationFromFields?.at(0)} }`,
          );
        })
        .writeLine(`, tx);`);
    });
}
